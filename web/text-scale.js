// Shared durable preference and same-package Host → Renderer contract.
export const TEXT_SCALES = Object.freeze([1, 1.25, 1.5]);
export const DEFAULT_TEXT_SCALE = 1;
export function textScale(value) {
  return TEXT_SCALES.includes(value) ? value : DEFAULT_TEXT_SCALE;
}
