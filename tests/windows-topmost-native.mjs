import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

assert.equal(process.platform, 'win32', 'Run on an isolated Windows interactive desktop');
const require = createRequire(import.meta.url), run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dsh-windows-topmost-'));
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), build: JSON.parse(await readFile('dist/build-info.json', 'utf8')), platform: process.platform, samples: [], physicalFullscreenAcceptance: false };
let app, handle;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => {
  const deadline = Date.now() + 6000;
  do { if (await check()) return; await pause(50); } while (Date.now() < deadline);
  assert.fail(message);
};
async function native(stage, clear = false) {
  assert.match(handle, /^\d+$/);
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TopmostProbe {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$hwnd = [IntPtr][long]${handle}
${clear ? 'if (![TopmostProbe]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x213)) { throw "SetWindowPos failed" }' : ''}
$style = [TopmostProbe]::GetWindowLongPtr($hwnd, -20).ToInt64()
@{ exstyle=$style; topmost=(($style -band 8) -ne 0); foreground=[TopmostProbe]::GetForegroundWindow().ToInt64().ToString() } | ConvertTo-Json -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const sample = { stage, ...JSON.parse(stdout.replace(/^\uFEFF/, '')) };
  report.samples.push(sample); return sample;
}
const petState = () => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'));
  return { topmost: win.isAlwaysOnTop(), visible: win.isVisible(), minimized: win.isMinimized() };
});
const pet = expression => app.evaluate(({ BrowserWindow }, expression) => {
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:'));
  if (expression === 'hide') win.hide();
  if (expression === 'show') win.showInactive();
  if (expression === 'minimize') win.minimize();
  if (expression === 'restore') win.restore();
}, expression);
try {
  app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', resolve('desktop/main.cjs')], env: { ...process.env, DSH_PET_TEST_DATA_DIR: root, DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_DEBUG_PORT: '0' } });
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { waitUntil: 'load' });
  await app.evaluate(() => process.emit('message', { type: 'init', baseline: true, options: { size: 150, roam: false, notifications: false }, snapshot: { mood: 'idle', active: false, sessions: [], results: [] } }));
  await until(async () => (await petState()).visible, 'pet must become visible');
  handle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
  report.electron = await app.evaluate(() => process.versions.electron);
  report.systemIdleState = await app.evaluate(({ powerMonitor }) => powerMonitor.getSystemIdleState(1));
  assert.equal((await native('initial')).topmost, true, 'visible pet must carry WS_EX_TOPMOST');
  assert.equal((await petState()).topmost, true);

  // A real competing window owns foreground focus. Controlled Win32 loss of
  // TOPMOST must be repaired without promoting the pet to foreground focus.
  await app.evaluate(async ({ BrowserWindow }) => {
    const other = new BrowserWindow({ width: 320, height: 200, show: false, webPreferences: { sandbox: true } });
    await other.loadURL('data:text/html,<title>Topmost regression foreground</title>');
    other.show(); other.focus();
  });
  const cleared = await native('cleared-visible', true);
  assert.equal(cleared.topmost, false, 'probe must actually remove WS_EX_TOPMOST');
  assert.notEqual(cleared.foreground, handle, 'another window must own foreground focus');
  const started = Date.now();
  await until(async () => (await petState()).topmost, 'visible pet must recover lost TOPMOST within two 3-second polls');
  report.recoveryMs = Date.now() - started;
  const repaired = await native('repaired-visible');
  assert.equal(repaired.topmost, true);
  assert.equal(repaired.foreground, cleared.foreground, 'repair must not steal foreground focus');

  await pet('hide');
  await until(async () => !(await petState()).visible, 'pet must hide');
  assert.equal((await native('cleared-hidden', true)).topmost, false);
  await pause(3500);
  assert.equal((await native('still-hidden')).topmost, false, 'hidden pet must not reassert TOPMOST');
  assert.equal((await petState()).visible, false);
  await pet('show');
  await until(async () => (await petState()).topmost && (await petState()).visible, 'show must restore TOPMOST');
  assert.equal((await native('shown')).topmost, true);

  await pet('minimize');
  await until(async () => (await petState()).minimized, 'pet must minimize');
  await native('cleared-minimized', true);
  await pet('restore');
  await until(async () => !(await petState()).minimized && (await petState()).topmost, 'restore must restore TOPMOST');
  assert.equal((await native('restored')).topmost, true);
  const closing = Date.now();
  let exitTimer;
  try { await Promise.race([app.close(), new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('native app must exit within 10 seconds')), 10000); })]); }
  finally { clearTimeout(exitTimer); }
  report.exitMs = Date.now() - closing; app = undefined;
  report.status = 'passed';
  console.log('Windows TOPMOST passed: Win32 style, controlled loss/recovery, unchanged foreground, hide/show, minimize/restore and normal exit.');
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); throw error; }
finally {
  try { await app?.close(); } finally {
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/windows-topmost-native.json', JSON.stringify(report, null, 2) + '\n');
    await rm(root, { recursive: true, force: true });
  }
}
