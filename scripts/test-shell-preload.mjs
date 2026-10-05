import test from 'node:test';
import assert from 'node:assert/strict';
import { planShellPreload } from '../lib/shell-preload-plan.ts';
import { saveBlobInAndroidShell } from '../lib/shell-file-save.ts';

test('first install preserves original IDs', () => {
  assert.deepEqual(planShellPreload([{ id: 'original-id' }], [], []), {
    apps: [{ id: 'original-id' }], seen: ['original-id'],
  });
});
test('existing edits win over a bundled version', () => {
  const edited = { id: 'a', version: 'local-edit' };
  assert.deepEqual(planShellPreload([{ id: 'a', version: 'bundle' }], [edited], []).apps, [edited]);
});
test('uninstalled apps are not resurrected on a new bundle', () => {
  assert.deepEqual(planShellPreload([{ id: 'a' }, { id: 'new' }], [], ['a']).apps, [{ id: 'new' }]);
});
test('repeated initialization is idempotent', () => {
  const first = planShellPreload([{ id: 'a' }], [], []);
  assert.deepEqual(planShellPreload([{ id: 'a' }], first.apps, first.seen), first);
});
test('pre-existing apps are recorded even when no installation is needed', () => {
  const first = planShellPreload([{ id: 'a' }], [{ id: 'a' }], []);
  assert.deepEqual(planShellPreload([{ id: 'a' }], [], first.seen).apps, []);
});

function mockWindow(bridge) {
  const target = new EventTarget();
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  target.AndroidShell = bridge;
  globalThis.window = target;
  return target;
}
test('native export preserves bytes across bounded chunks', async () => {
  const parts = [];
  let finished = false;
  const target = mockWindow({
    beginFileSave(id) { target.dispatchEvent(new CustomEvent('float-shell-save', { detail: { id, status: 'ready' } })); return true; },
    writeFileSaveChunk(id, value) { const b = Buffer.from(value, 'base64'); assert.ok(b.length <= 262144); parts.push(b); return true; },
    finishFileSave() { finished = true; return true; },
    cancelFileSave() { assert.fail('successful export should not cancel'); },
  });
  const bytes = Uint8Array.from({ length: 600000 }, (_, i) => i % 251);
  assert.equal(await saveBlobInAndroidShell(new Blob([bytes]), 'test.zip'), true);
  assert.equal(finished, true);
  assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes));
});
test('cancelled picker rejects without writing any data', async () => {
  let cancelled = false;
  const target = mockWindow({
    beginFileSave(id) { target.dispatchEvent(new CustomEvent('float-shell-save', { detail: { id, status: 'cancelled' } })); return true; },
    writeFileSaveChunk() { assert.fail('must not write on cancellation'); },
    finishFileSave() { assert.fail('must not finish on cancellation'); },
    cancelFileSave() { cancelled = true; },
  });
  await assert.rejects(saveBlobInAndroidShell(new Blob(['test']), 'test.zip'), { name: 'AbortError' });
  assert.equal(cancelled, true);
});
test('ordinary browsers keep the existing download path', async () => {
  mockWindow(undefined);
  assert.equal(await saveBlobInAndroidShell(new Blob(['test']), 'test.zip'), false);
});
