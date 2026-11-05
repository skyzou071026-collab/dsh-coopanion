import { it, expect } from 'vitest';
import { displayTarget, viewportPoint, panelPosition } from '../web/display-geometry.js';
import { createRequire } from 'node:module';
const { createDisplayController } = createRequire(import.meta.url)('../desktop/display-controller.cjs');
const display = (id, x, y, width, height, scaleFactor = 1) => ({ id, label: `Screen ${id}`, scaleFactor, workArea: { x, y, width, height } });
const irregular = [display(1, 0, 25, 1440, 835, 2), display(2, -1080, -700, 1080, 1880, 1), display(3, 300, -980, 1280, 920, 1.5)];
it('chooses every screen across negative origins, vertical offsets and portrait work areas', () => {
  for (const d of irregular) expect(displayTarget(irregular, { point: { x: d.workArea.x + 100, y: d.workArea.y + 100 } })).toBe(d);
  expect(displayTarget(irregular, { point: { x: 500, y: -500 }, currentId: 1 }).id).toBe(3);
});
it('does not treat taskbar strips or bounding-box holes as usable screens', () => {
  const layout = [display('left', -1000, 400, 1000, 700), display('top', 500, -900, 700, 850)];
  expect(displayTarget(layout, { point: { x: 300, y: 500 } }).id).toBe('left');
  expect(displayTarget(layout, { point: { x: 600, y: -20 } }).id).toBe('top');
});
it('keeps identity across unrelated changes and chooses nearest work area after removal', () => {
  expect(displayTarget(irregular, { currentId: 2 }).id).toBe(2);
  expect(displayTarget([irregular[0], irregular[2]], { currentId: 2, previous: irregular[1].workArea }).id).toBe(1);
  expect(displayTarget(irregular, { currentId: 1, displayId: 3 }).id).toBe(3);
  expect(displayTarget([display(0,0,0,0,0)], {})).toBeUndefined();
});
it('retains current identity on shared edges and uses DIP independently of raster scaling', () => {
  const layout = [display(1, -1000, 0, 1000, 800, 1), display(2, 0, 0, 1200, 800, 2)];
  expect(displayTarget(layout, { currentId: 2, point: { x: 0, y: 50 } }).id).toBe(2);
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    expect(displayTarget(layout.map(d => ({ ...d, scaleFactor })), { point: { x: -50, y: 400 } }).id).toBe(1);
    expect(viewportPoint({x: 100,y: 200}, {width: 800,height: 600}, {width: 800,height: 600})).toEqual({x:100,y:200});
  }
  expect(viewportPoint({x:400,y:300}, {width:800,height:600}, {width:640,height:480})).toEqual({x:320,y:240});
});
it('keeps measured panels inside a single work area at edges and narrow portrait widths', () => {
  for (const viewport of [{width:320,height:640}, {width:1080,height:1880}]) for (const anchor of [{x:-100,y:10}, {x:2000,y:2000}]) {
    const panel = {width: Math.min(300,viewport.width),height:400}, p = panelPosition(anchor,panel,viewport);
    expect(p.x).toBeGreaterThanOrEqual(0); expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x+panel.width).toBeLessThanOrEqual(viewport.width); expect(p.y+panel.height).toBeLessThanOrEqual(viewport.height);
  }
});
it('native controller replays switching, taskbars, unplugging and DPI/rotation changes without reload/show', () => {
  let layout = structuredClone(irregular), rectangle = {...layout[0].workArea}, cursor = {x:500,y:-500};
  const messages = [], moves = [];
  const screen = { getPrimaryDisplay: () => layout[0], getAllDisplays: () => layout, getCursorScreenPoint: () => cursor };
  const win = { isDestroyed: () => false, getBounds: () => rectangle, getContentBounds: () => ({...rectangle}), setBounds(b) { rectangle = {...b}; moves.push(b); } };
  const c = createDisplayController({screen, win, send: m => messages.push(m)});
  c.refresh(); expect(c.state.displayId).toBe(1);
  c.moveToCursor(); expect(c.state.displayId).toBe(3); expect(rectangle).toEqual(layout[2].workArea);
  expect(c.cursor()).toMatchObject({x:200,y:480,revision:c.state.revision});
  const before = c.state.revision;
  layout = layout.filter(d => d.id !== 2); c.refresh(); expect(c.state.displayId).toBe(3); expect(c.state.revision).toBe(before);
  layout[1].scaleFactor = 2; c.refresh(); expect(c.state.revision).toBe(before+1);
  layout[1].workArea = {x:300,y:-980,width:800,height:1200}; c.refresh(); expect(rectangle).toEqual(layout[1].workArea);
  layout = [layout[0]]; c.refresh(); expect(c.state.displayId).toBe(1); expect(rectangle).toEqual(layout[0].workArea);
  c.refresh({displayId:999}); expect(c.state.displayId).toBe(1);
  expect(messages.every(m => m.type === 'display-changed')).toBe(true);
  expect(moves.length).toBe(3);
});

it('re-reads settled content bounds when replaying geometry after an asynchronous resize', () => {
  const target = display(1, 0, 25, 1440, 1104, 1.25);
  let bounds = { ...target.workArea, height: 1152 }, content = { ...bounds };
  const messages = [];
  const controller = createDisplayController({
    screen: { getPrimaryDisplay: () => target, getAllDisplays: () => [target] },
    win: { isDestroyed: () => false, getBounds: () => bounds, getContentBounds: () => ({ ...content }), setBounds: value => { bounds = { ...value }; } },
    send: value => messages.push(value),
  });
  controller.refresh();
  expect(controller.state.contentBounds.height).toBe(1152);
  const revision = controller.state.revision;
  content = { ...bounds }; // Native content bounds settle after setBounds returns.
  controller.publish();
  expect(messages.at(-1).contentBounds.height).toBe(1104);
  expect(messages.at(-1).revision).toBeGreaterThan(revision);
  controller.publish();
  expect(messages.at(-1).revision).toBe(controller.state.revision);
});

it('ignores queued display work after its native window is destroyed', () => {
  const target = irregular[0], messages = [];
  let destroyed = false, calls = 0;
  const alive = () => { if (destroyed) throw new TypeError('Object has been destroyed'); calls++; };
  const controller = createDisplayController({
    screen: { getPrimaryDisplay: () => target, getAllDisplays: () => { alive(); return [target]; }, getCursorScreenPoint: () => { alive(); return { x: 0, y: 0 }; } },
    win: { isDestroyed: () => destroyed, getBounds: () => { alive(); return target.workArea; }, getContentBounds: () => { alive(); return target.workArea; } },
    send: value => messages.push(value),
  });
  controller.refresh(); const before = { calls, messages: messages.length };
  destroyed = true;
  expect(() => { controller.refresh(); controller.publish(); controller.moveToCursor(); }).not.toThrow();
  expect(controller.cursor()).toBeUndefined();
  expect({ calls, messages: messages.length }).toEqual(before);
});
