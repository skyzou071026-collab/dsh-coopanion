import { it, expect } from 'vitest';
import { initialNpc, npcSpace, stepNpc } from '../web/npc-life.js';
const layout = { x: 800, box: { x: 720, y: 560, w: 160, h: 160 } };
const space = npcSpace({ width: 1000, layout });
const base = { enabled: true, now: 0, keyboard: 'idle', layout, space, canWalk: true, words: ['stand', 'look', 'nod', 'neutral'] };
function fixture() {
  let state = initialNpc(3), now = 0;
  return { get state() { return state; }, tick(patch = {}, dt = 1000) { now += dt; const out = stepNpc(state, { ...base, now, ...patch }); state = out.state; return out; }, until(phase) { for (let i = 0; i < 60 && state.phase !== phase; i++) this.tick(); expect(state.phase).toBe(phase); return state; } };
}
it('constrains asymmetric body extents, scaling, small work areas and relative anchors', () => {
  expect(space.min).toBeGreaterThan(100); expect(space.max).toBeLessThan(900);
  expect(space.home).toBeGreaterThanOrEqual(space.min); expect(space.home).toBeLessThanOrEqual(space.max);
  expect(npcSpace({ width: 100, layout })).toBeNull();
  const wide = npcSpace({ width: 1800, layout: { x: 400, box: { x: 140, y: 0, w: 500, h: 400 } }, home: .05, range: .6, size: 240 });
  expect(wide.min).toBeGreaterThanOrEqual(272); expect(wide.max).toBeLessThanOrEqual(1548);
});
it('leaves home, waits for actual matching arrival, observes then returns with unique owned ids', () => {
  const f = fixture(); f.until('outbound'); const id = f.state.walkId, target = f.state.target;
  expect(id).toBeGreaterThan(3000000);
  f.tick({ event: { kind: 'arrived', walkId: id - 1 }, layout: { ...layout, x: target } }); expect(f.state.phase).toBe('outbound');
  f.tick({ event: { kind: 'arrived', walkId: id }, layout: { ...layout, x: target + 50 } }); expect(f.state.phase).toBe('resume');
  f.until('outbound'); const nextId = f.state.walkId;
  f.tick({ event: { kind: 'arrived', walkId: nextId }, layout: { ...layout, x: f.state.target } });
  expect(f.state.phase).toBe('observe'); expect(f.state.recent).toHaveLength(1);
  f.until('return'); expect(f.state.target).toBe(space.home); expect(f.state.walkId).toBeGreaterThan(nextId);
  f.tick({ event: { kind: 'arrived', walkId: f.state.walkId }, layout: { ...layout, x: space.home } }); expect(f.state.phase).toBe('home');
});
it('typing and pointer interruption preserve intent, stop only owned id, and debounce recovery', () => {
  const f = fixture(); f.until('outbound'); const { target, walkId } = f.state;
  expect(f.tick({ keyboard: 'active' }).stop).toBe(walkId); expect(f.state.target).toBe(target);
  expect(f.tick({ keyboard: 'active' }).stop).toBeUndefined();
  f.tick(); expect(f.state.phase).toBe('resume');
  for (let i = 0; i < 8; i++) f.tick(); expect(f.state.walkId).toBeNull();
  f.tick({ keyboard: 'active' }); f.tick(); for (let i = 0; i < 8; i++) f.tick(); expect(f.state.walkId).toBeNull();
  f.until('outbound'); const newId = f.state.walkId; expect(newId).not.toBe(walkId);
  f.tick({ event: { kind: 'arrived', walkId } }); expect(f.state.walkId).toBe(newId);
  expect(f.tick({ pointer: { x: layout.x, y: 600 } }).stop).toBe(newId); expect(f.state.reason).toBe('pointer');
});
it('unknown, work, physical ownership and lifecycle pause without erasing interest or emotion', () => {
  const f = fixture(); f.until('outbound'); const target = f.state.target;
  for (const patch of [{ work: true }, { user: true }, { keyboard: 'unknown' }, { lifecycle: true }]) { f.tick(patch); expect(f.state.target).toBe(target); expect(f.state.phase).toBe('yield'); }
  f.tick({}, 30000); expect(f.state.reason).toBe('lifecycle'); expect(f.state.target).toBe(target);
  f.tick({}, -100); expect(f.state.reason).toBe('lifecycle');
  f.tick({ enabled: false }); expect(f.state.walkId).toBeNull(); expect(f.state.target).toBe(target);
});
it('missing optional walk and vocabulary degrade safely, silent or unresponsive walkers time out', () => {
  const f = fixture(); for (let i = 0; i < 60; i++) { const out = f.tick({ canWalk: false, words: [] }); expect(out.walk).toBeUndefined(); expect(out.word).toBeUndefined(); }
  const g = fixture(); g.until('outbound'); const id = g.state.walkId;
  for (let i = 0; i < 22; i++) g.tick(); expect(g.state.walkId).toBeNull(); expect(g.state.failed).toBe(true);
  for (let i = 0; i < 60; i++) expect(g.tick().walk).toBeUndefined();
  expect(id).toBeGreaterThan(0);
});
it('revalidates geometry and never accepts callbacks from a previous body generation', () => {
  const f = fixture(); f.until('outbound'); const id = f.state.walkId;
  const small = npcSpace({ width: 500, layout, home: .2, range: .1 });
  expect(f.tick({ space: small }).stop).toBe(id); expect(f.state.target === null || f.state.target <= small.max).toBe(true);
  const result = stepNpc(initialNpc(4), { ...base, event: { kind: 'arrived', walkId: id } });
  expect(result.state.walkId).toBeNull(); expect(result.state.recent).toEqual([]);
});
it('already presented pending work allows only quiet home observation and retains a suspended exploration', () => {
  const f = fixture(); f.until('outbound'); const target = f.state.target;
  const stop = f.tick({ quiet: true, layout: { ...layout, x: space.home } }); expect(stop.stop).toBeTruthy();
  let observed = false;
  for (let i = 0; i < 40; i++) { const out = f.tick({ quiet: true, layout: { ...layout, x: space.home } }); expect(out.walk).toBeUndefined(); if (out.word) observed = true; }
  expect(observed).toBe(true); expect(f.state.target).toBe(target); expect(f.state.phase).toBe('yield');
  f.tick(); f.until('outbound'); expect(f.state.target).toBe(target);
});

it('keeps subpixel home boundaries stable and gives wide displays a bounded distance allowance', () => {
  const f = fixture(); f.until('outbound');
  f.tick({ event: { kind: 'arrived', walkId: f.state.walkId }, layout: { ...layout, x: f.state.target } });
  f.until('return'); const id = f.state.walkId;
  f.tick({ space: { ...space, max: space.home - 1e-10 }, layout: { ...layout, x: space.home - 20 } }); expect(f.state.walkId).toBe(id);
  const huge = npcSpace({ width: 5000, layout: { ...layout, x: 4000 }, range: .6 });
  const result = stepNpc({ ...initialNpc(1), spaceKey: huge.key, phase: 'prepare', placed: true, target: huge.min, dueAt: 0 }, { ...base, now: 1, space: huge, layout: { ...layout, x: huge.home } });
  expect(result.walk).toBeTruthy(); expect(result.state.dueAt).toBeGreaterThan(20000); expect(result.state.dueAt).toBeLessThanOrEqual(60001);
});

it('manual relocation retires the owned route and ignores its late arrival', () => {
  const f = fixture(); f.until('outbound'); const oldId = f.state.walkId;
  const out = f.tick({ relocated: true, user: true });
  expect(out.stop).toBe(oldId); expect(f.state.walkId).toBeNull(); expect(f.state.target).toBeNull(); expect(f.state.placed).toBe(true);
  f.tick({ event: { kind: 'arrived', walkId: oldId } });
  expect(f.state.recent).toEqual([]); expect(f.state.walkId).toBeNull();
  for (let i = 0; i < 10; i++) expect(f.tick().walk).toBeUndefined();
  f.until('outbound'); expect(f.state.walkId).toBeGreaterThan(oldId);
});
it('a manual placement made before initial activation is never overwritten, including outside the activity area', () => {
  const f = fixture();
  f.tick({ enabled: false, relocated: true, user: true }); expect(f.state.placed).toBe(true);
  for (let i = 0; i < 20; i++) {
    const out = f.tick({ layout: { ...layout, x: 80 } });
    expect(out.place).toBeUndefined(); expect(out.walk).toBeUndefined();
  }
  expect(f.state.reason).toBe('geometry');
  for (let i = 0; i < 20; i++) expect(f.tick().place).toBeUndefined();
});
