/** Shared Host/native lifetime contract. Only explicitly recoverable failures retry. */
export interface StartLifetime { signal: AbortSignal; generation: number; visible?: boolean; }
export interface NativeLifecycle {
  running: boolean; visible: boolean; error?: string;
  generation?: number; visibilityRevision?: number; suspended?: boolean;
  desiredVisible?: boolean; unexpected?: boolean;
}
export class NativeStartError extends Error {
  constructor(message: string, readonly recoverable: boolean) { super(message); this.name = 'NativeStartError'; }
}
