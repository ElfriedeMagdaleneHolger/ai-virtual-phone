type SaveBridge = {
  beginFileSave: (id: string, name: string, bytes: number) => boolean;
  writeFileSaveChunk: (id: string, base64: string) => boolean;
  finishFileSave: (id: string) => boolean;
  cancelFileSave: (id: string) => void;
};

export async function saveBlobInAndroidShell(blob: Blob, filename: string): Promise<boolean> {
  const bridge = (window as unknown as { AndroidShell?: SaveBridge }).AndroidShell;
  if (!bridge?.beginFileSave || !bridge.writeFileSaveChunk || !bridge.finishFileSave || !bridge.cancelFileSave) return false;
  const id = crypto.randomUUID();
  let cleanup = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("保存文件超时，请重试")), 180000);
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<{ id: string; status: string }>).detail;
        if (detail?.id !== id) return;
        if (detail.status === "ready") resolve();
        else if (detail.status === "cancelled") reject(new DOMException("已取消保存", "AbortError"));
        else reject(new Error("无法创建文件，请重试"));
      };
      window.addEventListener("float-shell-save", handler);
      cleanup = () => { window.clearTimeout(timer); window.removeEventListener("float-shell-save", handler); };
      if (!bridge.beginFileSave(id, filename, blob.size)) reject(new Error("另一个文件正在保存，请稍后重试"));
    });
    cleanup();
    for (let offset = 0; offset < blob.size; offset += 262144) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + 262144).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      if (!bridge.writeFileSaveChunk(id, btoa(binary))) throw new Error("文件写入失败，请重新导出");
    }
    if (!bridge.finishFileSave(id)) throw new Error("文件保存未完成，请重新导出");
    return true;
  } catch (error) {
    bridge.cancelFileSave(id);
    throw error;
  } finally { cleanup(); }
}
