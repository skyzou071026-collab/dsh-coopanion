// Windows can lose TOPMOST without a corresponding Electron window event.
// Check periodically while shown, but only repair a missing flag: repeatedly
// raising an already-topmost window changes its order among other overlays.
module.exports.installAlwaysOnTop = (win, { platform = process.platform, isSuspended = () => false } = {}) => {
  win.setAlwaysOnTop(true, platform === 'win32' ? 'screen-saver' : 'floating');
  if (platform !== 'win32') return () => {};
  let disposed = false, timer, pending;
  const pause = () => { clearInterval(timer); timer = undefined; clearImmediate(pending); pending = undefined; };
  const repair = () => {
    if (disposed || win.isDestroyed() || !win.isVisible() || win.isMinimized() || isSuspended()) return;
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  };
  const reconcile = () => {
    pending = undefined;
    if (disposed || win.isDestroyed() || !win.isVisible() || win.isMinimized()) { pause(); return; }
    repair();
    timer ??= setInterval(repair, 3000);
    timer.unref?.();
  };
  const schedule = () => { if (!disposed && pending === undefined) pending = setImmediate(reconcile); };
  const events = ['show', 'restore', 'focus', 'blur'];
  const dispose = () => {
    if (disposed) return;
    disposed = true; pause();
    for (const event of events) win.off(event, schedule);
    win.off('hide', pause); win.off('minimize', pause); win.off('closed', dispose);
  };
  for (const event of events) win.on(event, schedule);
  win.on('hide', pause); win.on('minimize', pause); win.once('closed', dispose);
  reconcile();
  return dispose;
};
