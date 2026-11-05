import { it, expect } from 'vitest';
import { createCompanionStroke } from '../web/companion-touch.js';
it('counts trusted continuous strokes, never entry teleports, presses or untrusted input', () => {
  const stroke = createCompanionStroke(); let now = 0;
  const move = (x, patch = {}) => stroke.move({ x, y: 100 }, { trusted: true, over: true, pressing: false, now: now += 10, ...patch });
  expect(move(1500)).toBe(false);
  for (let i = 0; i < 10; i++) expect(move(i * 100, { trusted: false })).toBe(false);
  for (let i = 0; i < 10; i++) expect(move(i * 100, { pressing: true })).toBe(false);
  const results = []; for (let i = 0; i < 15; i++) results.push(move(i % 2 ? 100 : 150));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(move(5000, { over: false })).toBe(false); expect(move(100)).toBe(false);
});

it('distinguishes a slow decaying trace from a continuous deliberate stroke', () => {
  const stroke = createCompanionStroke(); let now = 0;
  const move = interval => stroke.move({ x: (now / interval) % 2 ? 100 : 150, y: 100 }, { trusted: true, over: true, pressing: false, now: now += interval });
  for (let i = 0; i < 20; i++) expect(move(1000)).toBe(false);
  stroke.reset(); now = 0;
  expect(Array.from({length: 18}, () => move(10)).filter(Boolean).length).toBe(1);
});
