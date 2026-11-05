const { displayTarget } = require('../web/display-geometry.js');

// The injected screen/window are also used by the deterministic CI layout tests.
module.exports.createDisplayController = ({ screen, win, send, changed = () => {} }) => {
  let currentId = screen.getPrimaryDisplay().id, previous, state, lastKey, revision = 0;
  const alive = () => !win.isDestroyed();
  const emit = () => { if (state && alive()) send({ type: 'display-changed', ...state }); };
  // A replay must sample again: getContentBounds can settle after setBounds.
  const publish = () => { if (!alive()) return; const before = revision; refresh(); if (before === revision) emit(); };
  function refresh({ point, displayId } = {}) {
    if (!alive()) return;
    const target = displayTarget(screen.getAllDisplays(), { currentId, previous, point, displayId });
    if (!target) return;
    currentId = target.id; previous = { ...target.workArea };
    const b = win.getBounds();
    if (['x', 'y', 'width', 'height'].some(k => b[k] !== target.workArea[k])) win.setBounds(target.workArea);
    const next = { displayId: target.id, workArea: { ...target.workArea }, contentBounds: win.getContentBounds(), scaleFactor: target.scaleFactor };
    const key = JSON.stringify(next);
    if (key !== lastKey) {
      lastKey = key; state = { ...next, revision: ++revision }; emit(); changed();
    }
  }
  return { refresh, publish, get state() { return state; }, moveToCursor() { if (!alive()) return; const before = revision; refresh({ point: screen.getCursorScreenPoint() }); if (before === revision) publish(); },
    cursor() { if (!alive()) return; const p = screen.getCursorScreenPoint(), b = state?.contentBounds; return b ? { type: 'cursor', x: p.x - b.x, y: p.y - b.y, revision: state.revision } : undefined; } };
};
