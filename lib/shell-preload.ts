import JSZip from "jszip";
import { loadInstalledCustomApps, saveInstalledCustomApps } from "./custom-app-storage";
import { deserializeStorageString } from "./data-management/serializers";
import { kvGet, kvSetAsync } from "./kv-db";
import { sha256BlobHex } from "./sha256-stream";
import { planShellPreload } from "./shell-preload-plan";
import type { InstalledCustomApp } from "./custom-app-types";

const STATE_KEY = "ai_phone_shell_preload_state_v1";
const APPS_KEY = "ai_phone_custom_apps_v1";
let running: Promise<void> | null = null;

export function initializeShellPreload(): Promise<void> {
  const bridge = (window as unknown as { AndroidShell?: { getPreloadInfo?: () => string } }).AndroidShell;
  if (!bridge?.getPreloadInfo) return Promise.resolve();
  if (running) return running;
  running = run(bridge.getPreloadInfo()).finally(() => { running = null; });
  return running;
}

async function run(infoJson: string): Promise<void> {
  if (!infoJson) return;
  const info = JSON.parse(infoJson) as { sha256: string; url: string };
  const url = new URL(info.url, location.href);
  if (url.origin !== location.origin || url.pathname !== "/__float_shell_assets/preinstalled.zip" || !/^[a-f0-9]{64}$/.test(info.sha256)) {
    throw new Error("预装资源地址无效");
  }
  const state = JSON.parse(kvGet(STATE_KEY) || '{"seen":[]}') as { sha256?: string; seen: string[]; pending?: string[] };
  if (state.sha256 === info.sha256) return;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取 APK 预装应用");
  const blob = await response.blob();
  if (await sha256BlobHex(blob) !== info.sha256) throw new Error("APK 预装包校验失败");
  const zip = await JSZip.loadAsync(blob);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  if (manifest.format !== "ai-phone-backup" || manifest.version !== 2 || manifest.modules.length !== 1 || manifest.modules[0].id !== "apps") {
    throw new Error("预装包只能包含应用代码");
  }
  let incoming: InstalledCustomApp[] | null = null;
  for (const [name, file] of Object.entries(zip.files)) {
    if (!name.startsWith("modules/") || !name.endsWith(".json")) continue;
    const payload = JSON.parse(await file.async("string"));
    if (payload.moduleId !== "apps") throw new Error("预装包包含个人数据");
    for (const source of payload.sources) {
      if (source.type !== "kv") throw new Error("预装包数据类型无效");
      for (const record of source.records) {
        if (record.key !== APPS_KEY || incoming) throw new Error("预装包包含多余数据");
        const raw = await deserializeStorageString(record.value, async ref => {
          const entry = zip.file(`media/${ref}.bin`);
          if (!entry) throw new Error("预装应用缺少素材");
          const media = await entry.async("blob");
          if (await sha256BlobHex(media) !== ref) throw new Error("预装素材校验失败");
          return media;
        });
        incoming = JSON.parse(raw);
      }
    }
  }
  if (!Array.isArray(incoming) || incoming.some(app => !app.id || !app.entryHtml || !app.manifest)) throw new Error("预装应用无效");
  if (new Set(incoming.map(app => app.id)).size !== incoming.length) throw new Error("预装应用 ID 重复");
  const existing = loadInstalledCustomApps();
  const previousIds = new Set(existing.map(app => app.id));
  const plan = planShellPreload(incoming, existing, state.seen || []);
  // Use the host normalizer, then await durable writes before marking the package complete.
  const normalized = saveInstalledCustomApps(plan.apps, false);
  if (normalized.length !== plan.apps.length) throw new Error("应用格式不兼容，请保留备份并重试");
  await kvSetAsync(APPS_KEY, JSON.stringify(normalized));
  await kvSetAsync(STATE_KEY, JSON.stringify({ sha256: info.sha256, seen: plan.seen,
    pending: [...new Set([...(state.pending || []), ...plan.apps.filter(app => !previousIds.has(app.id)).map(app => app.id)])] }));
}

export function pendingShellPreloadIds(): string[] {
  return (JSON.parse(kvGet(STATE_KEY) || '{}') as { pending?: string[] }).pending || [];
}

export async function completeShellPreloadPlacement(): Promise<void> {
  const state = JSON.parse(kvGet(STATE_KEY) || '{}');
  await kvSetAsync(STATE_KEY, JSON.stringify({ ...state, pending: [] }));
}
