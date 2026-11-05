import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listDiagnostics } from '../scripts/diagnostics-client.mjs';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => { vi.mocked(readFile).mockRestore(); vi.unstubAllGlobals(); });
const denied = () => Object.assign(new Error('descriptor is pending deletion'), { code: 'EPERM' });
async function discovery(run, platform = 'win32') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-'));
  const registry = join(root, 'registry'), path = join(registry, 'a'.repeat(20) + '-' + process.pid + '.json');
  const endpoint = { schema: 1, instance: 'a'.repeat(20), session: 'b'.repeat(32), token: 'c'.repeat(64), pid: process.pid, socketPath: 'test-socket', version: '0.4.11', startedAt: new Date().toISOString() };
  await mkdir(registry); await writeFile(path, JSON.stringify(endpoint), { mode: 0o600 });
  vi.stubGlobal('process', { ...process, platform });
  try { await run({ registry, path, endpoint }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
it('tolerates a Windows descriptor withdrawn between stat and read', async () => discovery(async ({ registry, path }) => {
  vi.mocked(readFile).mockImplementationOnce(async () => { await unlink(path); throw denied(); });
  expect(await listDiagnostics(registry)).toEqual([]);
}));
it('recovers a transient Windows read denial and still validates the descriptor', async () => discovery(async ({ registry, endpoint }) => {
  vi.mocked(readFile).mockRejectedValueOnce(denied());
  expect(await listDiagnostics(registry)).toEqual([endpoint]);
  expect(readFile).toHaveBeenCalledTimes(2);
}));
it('bounds persistent Windows read failures instead of hiding them', async () => discovery(async ({ registry }) => {
  vi.mocked(readFile).mockRejectedValue(denied());
  await expect(listDiagnostics(registry)).rejects.toMatchObject({ code: 'EPERM' });
  expect(readFile).toHaveBeenCalledTimes(3);
}));
it.skipIf(process.platform === 'win32')('preserves POSIX permission failures without retrying', async () => discovery(async ({ registry }) => {
  vi.mocked(readFile).mockRejectedValue(denied());
  await expect(listDiagnostics(registry)).rejects.toMatchObject({ code: 'EPERM' });
  expect(readFile).toHaveBeenCalledTimes(1);
}, 'darwin'));
it('does not retry or hide malformed descriptor data', async () => discovery(async ({ registry }) => {
  vi.mocked(readFile).mockResolvedValueOnce('{');
  await expect(listDiagnostics(registry)).rejects.toBeInstanceOf(SyntaxError);
  expect(readFile).toHaveBeenCalledTimes(1);
}));
it('skips a dead process descriptor without retrying it', async () => discovery(async ({ registry }) => {
  const kill = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('dead process'), { code: 'ESRCH' }); })
    .mockImplementation(() => { throw new Error('dead descriptor was revisited'); });
  process.kill = kill;
  expect(await listDiagnostics(registry)).toEqual([]);
  expect(kill).toHaveBeenCalledTimes(1);
}));
