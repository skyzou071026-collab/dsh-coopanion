export type TextScale = 1 | 1.25 | 1.5;
export const TEXT_SCALES: readonly TextScale[];
export const DEFAULT_TEXT_SCALE: 1;
export function textScale(value: unknown): TextScale;
