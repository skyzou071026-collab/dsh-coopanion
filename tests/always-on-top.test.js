import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { installAlwaysOnTop } = createRequire(import.meta.url)('../desktop/always-on-top.cjs');
function window() {
  const win = new EventEmitter();
  Object.assign(win, { visible: true, minimized: false, destroyed: false, topmost: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => { if (win.destroyed) throw Error('destroyed'); return win.visible; },
    isMinimized: () => { if (win.destroyed) throw Error('destroyed'); return win.minimized; },
    isAlwaysOnTop: () => { if (win.destroyed) throw Error('destroyed'); return win.topmost; },
    setAlwaysOnTop: vi.fn(() => { if (win.destroyed) throw Error('destroyed'); win.topmost = true; }),
    focus: vi.fn(), show: vi.fn(), showInactive: vi.fn(),
  });
  return win;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it.each(['darwin', 'linux'])('%s retains floating and installs no Windows recovery', platform => {
  const win = window(), dispose = installAlwaysOnTop(win, { platform });
  expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, 'floating']]);
  expect(win.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  dispose();
});
it('repairs actual Windows flag loss while leaving an intact topmost window and focus alone', () => {
  const win = window(), dispose = installAlwaysOnTop(win, { platform: 'win32' });
  expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]);
  vi.advanceTimersByTime(6000); expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(1);
  win.topmost = false; vi.advanceTimersByTime(3000);
  expect(win.topmost).toBe(true); expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(2);
  expect(win.focus).not.toHaveBeenCalled(); expect(win.show).not.toHaveBeenCalled(); expect(win.showInactive).not.toHaveBeenCalled();
  dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('does not revive a hidden window through queued events or polling, and repairs on show', () => {
  const win = window(), dispose = installAlwaysOnTop(win, { platform: 'win32' });
  win.topmost = false; win.emit('blur'); win.emit('focus');
  win.visible = false; win.emit('hide'); vi.advanceTimersByTime(6000);
  expect(win.topmost).toBe(false); expect(vi.getTimerCount()).toBe(0);
  win.visible = true; win.emit('show'); vi.advanceTimersByTime(1);
  expect(win.topmost).toBe(true); expect(vi.getTimerCount()).toBe(1);
  dispose();
});
it('skips suspended state and resumes repair without replaying window activation', () => {
  const win = window(); let suspended = false;
  const dispose = installAlwaysOnTop(win, { platform: 'win32', isSuspended: () => suspended });
  win.topmost = false; suspended = true; win.emit('blur'); vi.advanceTimersByTime(6000);
  expect(win.topmost).toBe(false);
  suspended = false; vi.advanceTimersByTime(3000); expect(win.topmost).toBe(true);
  expect(win.focus).not.toHaveBeenCalled(); dispose();
});
it('pauses minimized windows and repairs after restore', () => {
  const win = window(), dispose = installAlwaysOnTop(win, { platform: 'win32' });
  win.topmost = false; win.minimized = true; win.emit('minimize'); vi.advanceTimersByTime(6000);
  expect(win.topmost).toBe(false); expect(vi.getTimerCount()).toBe(0);
  win.minimized = false; win.emit('restore'); vi.advanceTimersByTime(1);
  expect(win.topmost).toBe(true); dispose();
});
it('cancels queued work and subscriptions on destruction or explicit app shutdown', () => {
  for (const destroy of [true, false]) {
    const win = window(), dispose = installAlwaysOnTop(win, { platform: 'win32' });
    win.topmost = false; win.emit('focus');
    if (destroy) { win.destroyed = true; win.emit('closed'); } else dispose();
    dispose(); win.emit('show'); win.emit('restore'); vi.advanceTimersByTime(6000);
    expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    expect(win.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  }
});
