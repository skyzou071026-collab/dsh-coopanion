// Global rectangles/points are Electron DIP; local rectangles are CSS pixels.
// A display's raster scale is metadata, never a multiplier for global origins.
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const distance = (p, r) => Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.width), Math.max(r.y - p.y, 0, p.y - r.y - r.height));

/** Keep current identity unless an explicit point/id requests a switch; recover nearest on removal. */
export function displayTarget(displays, { currentId, previous, point, displayId } = {}) {
  const available = displays.filter(d => validRect(d.workArea));
  const explicit = available.find(d => d.id === displayId);
  if (explicit) return explicit;
  const current = available.find(d => d.id === currentId);
  if (!point && current) return current;
  const p = point ?? (validRect(previous) ? { x: previous.x + previous.width / 2, y: previous.y + previous.height / 2 } : undefined);
  if (!p) return available[0];
  // Put the current display first so shared edges and equal distances do not bounce.
  const ordered = current ? [current, ...available.filter(d => d !== current)] : available;
  return ordered.reduce((best, d) => !best || distance(p, d.workArea) < distance(p, best.workArea) ? d : best, undefined);
}

/** Convert window-local DIP to actual viewport CSS units, without applying raster DPR. */
export function viewportPoint(point, contentBounds, viewport) {
  return { x: point.x * viewport.width / contentBounds.width, y: point.y * viewport.height / contentBounds.height };
}

/** Clamp a measured panel to one usable viewport, including narrow/short work areas. */
export function panelPosition(anchor, panel, viewport) {
  return { x: clamp(anchor.x - panel.width / 2, Math.min(8, Math.max(0, viewport.width - panel.width)), viewport.width - panel.width - 8),
    y: clamp(anchor.y - panel.height - 18, Math.min(8, Math.max(0, viewport.height - panel.height)), viewport.height - panel.height - 12) };
}
