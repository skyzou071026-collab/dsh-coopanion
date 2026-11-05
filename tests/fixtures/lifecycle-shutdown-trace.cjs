// Loaded only by the controlled native lifecycle probe. No paths, URLs or text.
const { app, BrowserWindow } = require('electron');
// Observe Electron's default exception path without handling or suppressing it.
// Keep only error classifications and source basenames in this empty probe.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  const frames = String(error?.stack ?? '').split('\n').slice(1, 13).flatMap(line => {
    const match = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    return match ? [{ function: match[1] ?? null, file: match[2].split(/[\\/]/).at(-1).replace(/[?#].*$/, ''), line: Number(match[3]), column: Number(match[4]) }] : [];
  });
  const kind = /object.*destroyed/i.test(error?.message ?? '') ? 'object-destroyed'
    : /channel.*closed|closed.*channel/i.test(error?.message ?? '') ? 'closed-ipc' : 'unclassified';
  const exception = { origin, name: error?.name, code: error?.code, kind, frames };
  try { require('node:fs').writeSync(2, 'Lifecycle exception: ' + JSON.stringify(exception) + '\n'); } catch {}
});
function trace(phase) {
  let windows = [], inspectionFailed = false;
  const resources = {};
  try {
    windows = app.isReady() ? BrowserWindow.getAllWindows().map(win => ({
      destroyed: win.isDestroyed(), visible: !win.isDestroyed() && win.isVisible(),
      loading: !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.isLoading(),
    })) : [];
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
  } catch { inspectionFailed = true; }
  try { if (process.connected) process.send({ type: 'lifecycle-shutdown-trace', phase, windows, resources, inspectionFailed }, () => {}); } catch {}
}
process.prependListener('message', message => {
  if (message?.type !== 'quit') return;
  trace('quit-received');
  setImmediate(() => trace('quit-immediate'));
  setTimeout(() => trace('quit-after-one-second'), 1000).unref();
});
app.on('browser-window-created', (_event, win) => {
  win.on('close', () => trace('window-close'));
  win.on('closed', () => trace('window-closed'));
});
for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => trace(event));
