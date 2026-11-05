import { it, expect } from 'vitest';
import { textScale } from '../web/text-scale.js';

it('uses a safe renderer default for unsupported wire values', () => {
  for (const value of [1, 1.25, 1.5]) expect(textScale(value)).toBe(value);
  for (const value of [undefined, null, NaN, Infinity, 0, 125, '1.5', {}]) expect(textScale(value)).toBe(1);
});
