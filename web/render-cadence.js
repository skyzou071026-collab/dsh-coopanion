/** A paint cap, not a synthetic clock: busy frames bypass the cap and retain accumulated dt. */
export function advanceRenderCadence(state, now, dt, idle) {
  const elapsed = Math.min(.05, state.elapsed + Math.max(0, dt));
  const paint = !idle || now - state.at >= 1000 / 30;
  return { at: paint ? now : state.at, elapsed: paint ? 0 : elapsed, paint, dt: paint ? elapsed : 0 };
}
