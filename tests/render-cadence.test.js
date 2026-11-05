import { it, expect } from 'vitest';
import { advanceRenderCadence } from '../web/render-cadence.js';
it('caps a 60Hz idle stream and restores the next busy frame without dropping accumulated time', () => {
  let state = { at: -Infinity, elapsed: 0 }, count = 0, elapsed = 0;
  for (let frame = 1; frame <= 120; frame++) {
    state = advanceRenderCadence(state, frame * 1000 / 60, 1 / 60, true);
    if (state.paint) { count++; elapsed += state.dt; }
  }
  expect(count).toBeLessThanOrEqual(61); expect(count).toBeGreaterThanOrEqual(40);
  const busy = advanceRenderCadence(state, 2016.667, 1 / 60, false);
  expect(busy.paint).toBe(true);
  expect(elapsed + busy.dt).toBeCloseTo(121 / 60, 5);
});
it('does not invent higher frame rates on a 20Hz renderer or replay a long scheduling gap', () => {
  let state = { at: -Infinity, elapsed: 0 }, paints = 0;
  for (let frame = 1; frame <= 40; frame++) { state = advanceRenderCadence(state, frame * 50, .05, true); paints += Number(state.paint); }
  expect(paints).toBe(40);
  state = advanceRenderCadence(state, 12000, 10, false);
  expect(state.dt).toBe(.05);
});
