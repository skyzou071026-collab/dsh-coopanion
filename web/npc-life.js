// Runtime-only intent. No content, offline progress, model calls or relationship scoring.
export const NPC_PHASES = ['home', 'prepare', 'outbound', 'observe', 'return', 'yield', 'resume'];
export const NPC_REASONS = ['none', 'disabled', 'input', 'unknown', 'pointer', 'work', 'user', 'lifecycle', 'geometry', 'capability'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const WALK_STRIDE = 2 ** 32;
export function npcSpace({ width, layout, home = .85, range = .3, size = 180 }) {
  if (!Number.isFinite(width) || width < 32 || !layout?.box || !Number.isFinite(layout.x) || layout.box.w <= 0) return null;
  // Keep both measured asymmetric extents and a scale-based motion margin inside workArea.
  home = Number.isFinite(home) ? home : .85; range = Number.isFinite(range) ? range : .3;
  const left = Math.max(layout.x - layout.box.x, size * .55) + Math.max(12, size * .15);
  const right = Math.max(layout.box.x + layout.box.w - layout.x, size * .55) + Math.max(12, size * .15);
  if (left + right >= width) return null;
  const lo = left, hi = width - right;
  const anchor = clamp(width * clamp(home, .05, .95), lo, hi);
  const span = Math.min(hi - lo, width * clamp(range, .1, .6));
  const min = clamp(anchor - (home > .5 ? span : 0), lo, hi - span), max = min + span;
  return { min, max, home: anchor, key: [width, size, home, range].join(':') };
}
export const initialNpc = (generation = 0) => ({ generation, serial: 0, phase: 'home', reason: 'disabled', target: null, returning: false, recent: [], energy: .6, interest: .5, emotion: 'neutral', walkId: null, dueAt: null, lastAt: null, safeAt: null, spaceKey: null, placed: false, failed: false });
const word = (words, ...choices) => choices.find(w => words.includes(w));
export function stepNpc(state, input) {
  const { now, space, keyboard = 'unknown', pointer, layout, words = [], event } = input;
  const next = { ...state, recent: [...state.recent], lastAt: now }, out = { state: next };
  const stop = () => { if (next.walkId) out.stop = next.walkId; next.walkId = null; };
  const pause = reason => { stop(); next.phase = 'yield'; next.reason = reason; next.safeAt = null; next.dueAt = null; };
  const gap = state.lastAt !== null && (now < state.lastAt || now - state.lastAt > 10000);
  // A manual move replaces this route and the pending initial home placement.
  // Keep serial/generation so a retired walk cannot complete a later route.
  if (input.relocated) {
    next.target = null; next.returning = false; next.placed = true; next.failed = false;
    pause(input.enabled ? 'user' : 'disabled'); return out;
  }
  if (!input.enabled) { pause('disabled'); return out; }
  if (input.lifecycle || gap) { pause('lifecycle'); return out; }
  if (input.user) { pause('user'); return out; }
  if (!space) { pause('geometry'); return out; }
  if (space.key !== state.spaceKey) { stop(); next.spaceKey = space.key; next.target = state.target === null ? null : clamp(state.target, space.min, space.max); next.phase = 'resume'; next.dueAt = now + 2000; next.failed = false; }
  const targetValid = next.target !== null && next.target >= space.min - .01 && next.target <= space.max + .01;
  if (next.target !== null && !targetValid) { stop(); next.target = null; next.phase = 'resume'; next.dueAt = now + 2000; }
  const box = layout?.box;
  const near = pointer && box && pointer.y >= box.y - 45 && pointer.y <= box.y + box.h + 45 &&
    pointer.x >= Math.min(box.x, next.walkId ? next.target - box.w / 2 : box.x) - 45 &&
    pointer.x <= Math.max(box.x + box.w, next.walkId ? next.target + box.w / 2 : box.x + box.w) + 45;
  const reason = keyboard === 'active' ? 'input' : keyboard !== 'idle' ? 'unknown' : input.work ? 'work' : near ? 'pointer' : null;
  if (reason) { pause(reason); return out; }
  if (next.placed && (layout.x < space.min - 2 || layout.x > space.max + 2)) { pause('geometry'); return out; }
  if (input.quiet) {
    stop(); next.phase = 'yield'; next.reason = 'work'; next.safeAt = null;
    next.dueAt = state.reason === 'work' && state.dueAt !== null ? state.dueAt : now + 15000;
    if (now >= next.dueAt) { if (Math.abs(layout.x - space.home) < 40) out.word = word(words, 'look', 'nod'); next.dueAt = now + 15000; }
    return out;
  }
  next.reason = next.failed || !input.canWalk ? 'capability' : 'none';
  if (state.phase === 'yield') { next.phase = 'resume'; next.safeAt = now; next.dueAt = now + 12000; out.word = word(words, 'stand'); return out; }
  if (next.phase === 'resume') {
    if (now < next.dueAt) return out;
    next.phase = next.target === null ? 'home' : 'prepare'; next.dueAt = now + 1800;
    out.word = word(words, 'look', 'nod'); return out;
  }
  if (!next.placed) { next.placed = true; out.place = space.home; next.phase = 'home'; next.dueAt = now + 7000; return out; }
  if (next.walkId) {
    if (event?.walkId === next.walkId && ['arrived', 'interrupted'].includes(event.kind)) {
      const arrived = event.kind === 'arrived' && Math.abs(layout.x - next.target) <= 6;
      stop();
      if (arrived) {
        next.phase = next.returning ? 'home' : 'observe'; next.recent = [...next.recent, next.target].slice(-3);
        next.target = null; next.dueAt = now + (next.returning ? 10000 : 6500);
        next.energy = clamp(next.energy + (next.returning ? .03 : -.06), 0, 1);
        next.interest = clamp(next.interest + (next.returning ? .03 : -.08), 0, 1);
        next.emotion = next.returning ? 'neutral' : next.energy < .35 ? 'sleepy' : 'happy';
        out.word = next.returning ? word(words, 'sit', 'nod') : word(words, 'look', 'nod');
      } else { next.phase = 'resume'; next.dueAt = now + 12000; }
    } else if (now >= next.dueAt) { stop(); next.failed = true; next.phase = 'home'; next.reason = 'capability'; next.dueAt = now + 15000; }
    return out;
  }
  if (now < next.dueAt) return out;
  if (next.phase === 'home' || next.phase === 'observe') {
    next.energy = clamp(next.energy + (next.phase === 'home' ? .05 : -.03), 0, 1); next.interest = clamp(next.interest + .04, 0, 1);
    next.returning = next.phase === 'observe';
    const points = [.15, .5, .85].map(f => space.min + (space.max - space.min) * f);
    next.target = next.returning ? space.home : points.sort((a, b) => score(b) - score(a))[0];
    function score(p) { return Math.abs(p - layout.x) - (next.recent.some(v => Math.abs(v - p) < 20) ? 100 : 0); }
    next.phase = 'prepare'; next.dueAt = now + 1800; next.emotion = 'thinking'; out.word = word(words, 'stand'); return out;
  }
  if (next.phase === 'prepare') {
    if (!input.canWalk || next.failed || space.max - space.min < 30) {
      next.phase = next.returning ? 'home' : 'observe'; next.target = null; next.reason = 'capability'; next.dueAt = now + 10000;
      out.word = word(words, 'look', 'nod', 'neutral'); return out;
    }
    if (next.serial >= WALK_STRIDE - 1 || next.generation >= 2 ** 21) { next.failed = true; return out; }
    next.serial++; next.walkId = next.generation * WALK_STRIDE + next.serial;
    next.phase = next.returning ? 'return' : 'outbound';
    next.dueAt = now + Math.min(60000, Math.max(20000, Math.abs(next.target - layout.x) / 30 * 1000 + 5000));
    out.walk = { x: next.target, id: next.walkId }; out.word = word(words, 'stand');
  }
  return out;
}
