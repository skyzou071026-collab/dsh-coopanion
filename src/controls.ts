import type { DesktopOptions, PetBridge } from './bridge.ts';
import type { NotificationRuntime } from './notification-contract.ts';
import { NativeStartError, type NativeLifecycle } from './desktop-lifecycle.ts';
export { NativeStartError, type NativeLifecycle, type StartLifetime } from './desktop-lifecycle.ts';

export type PetCommand = 'start' | 'show' | 'hide' | 'restart' | 'stop' | 'characters';
export type PetStatus = NotificationRuntime;
/** A host-authored hint. Views render it as a transient toast; it never carries task state or delivery claims. */
export interface PetHint {
  /** One-line headline. Blank headlines are dropped. */
  title: string;
  /** Optional supporting line; the view keeps it to two visible lines. */
  body?: string;
  /** Optional Harness session the hint belongs to. It is passed through verbatim; invalid ids reject the hint. */
  sessionId?: string;
}
export interface ControlLimits { startTimeoutMs?: number; cleanupTimeoutMs?: number; retryDelaysMs?: readonly [number, number, number]; stableMs?: number; }

/** Commands own a cancellable native generation. Lifecycle acknowledgements alone establish visibility. */
export class PetControls {
  private state: PetStatus = { phase: 'stopped', visible: false, desiredVisible: true, recoveryAttempt: 0, generation: 0, visibilityRevision: 0, suspended: false };
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private startup?: AbortController;
  private startupExit?: NativeStartError;
  private retry?: ReturnType<typeof setTimeout>;
  private stable?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private wanted = false;
  private cleanupBlocked = false;
  private readonly listeners = new Set<(status: PetStatus) => void>();
  private readonly changed = (event: NativeLifecycle) => {
    if (this.disposed || event.generation !== this.state.generation || !Number.isSafeInteger(event.visibilityRevision) || event.visibilityRevision! < this.state.visibilityRevision) return;
    if (event.visibilityRevision === this.state.visibilityRevision && event.visible !== this.state.visible) return;
    if (this.state.phase !== 'starting' && this.state.phase !== 'running') return;
    const starting = this.state.phase === 'starting', wasSuspended = this.state.suspended;
    this.set({ ...this.state, phase: event.running ? starting ? 'starting' : 'running' : starting ? 'starting' : 'stopped', visible: event.running && event.visible, visibilityRevision: event.visibilityRevision!, suspended: event.suspended ?? false, desiredVisible: starting ? this.state.desiredVisible : event.desiredVisible ?? this.state.desiredVisible, ...(event.error ? { error: event.error.slice(0, 600) } : {}) });
    if (!event.running) {
      this.clearStable();
      if (starting) { this.startupExit = new NativeStartError(event.error ?? '桌宠启动期间退出', event.unexpected === true); this.startup?.abort(); }
      if (!starting) {
        if (!event.unexpected) this.wanted = false;
        else { const epoch = this.epoch; void this.enqueue(() => this.failed(event.error ?? '桌宠进程意外退出', true, epoch)); }
      }
    } else if (!starting && wasSuspended !== this.state.suspended) this.armStable();
  };
  constructor(private readonly bridge: PetBridge, private readonly options: () => DesktopOptions, private readonly limits: ControlLimits = {}) {
    bridge.onLifecycle?.(this.changed);
  }
  status(): PetStatus { return { ...this.state }; }
  /** Root assembly registers this listener as a context-owned effect. */
  onState(listener: (status: PetStatus) => void): () => void {
    this.listeners.add(listener); try { listener(this.status()); } catch { /* A view is optional. */ } return () => this.listeners.delete(listener);
  }
  configure(): void { this.bridge.configure?.(this.options()); }
  /**
   * Relay a host-authored hint to the pet as a toast. Delivery is best-effort:
   * it needs a running, visible, awake pet with notices enabled. The result is
   * whether the Host handed the message to the native IPC channel after its own
   * generation/visibility check; the native window re-checks and may still drop
   * it, so true never means the user saw it. Task notices, session replies and
   * delivery claims stay owned by the broker; a hint can never fabricate them.
   * Session ids are navigation identity: they are validated but never rewritten.
   */
  hint(value: PetHint): boolean {
    if (this.disposed || !this.options().notifications) return false;
    if (this.state.phase !== 'running' || !this.state.visible || this.state.suspended) return false;
    const title = hintText(value.title, 256), body = hintText(value.body, 2048);
    if (!title) return false;
    const sessionId = hintSessionId(value.sessionId);
    if (sessionId === false) return false;
    return this.bridge.notify({ title, body, sessionId: sessionId ?? '', kind: 'message' }, this.status());
  }
  command(command: PetCommand): Promise<PetStatus> {
    // Intent and cancellation take effect before queued work, including queued starts.
    if (command === 'hide') this.set({ ...this.state, desiredVisible: false });
    else if (command === 'start' || command === 'show' || command === 'characters') this.set({ ...this.state, desiredVisible: true });
    if (command === 'stop' || command === 'restart' || (command !== 'hide' && this.state.phase !== 'starting' && this.state.phase !== 'running')) {
      this.wanted = command !== 'stop'; this.epoch++; this.clearRetry();
      if (command === 'stop' || command === 'restart') { this.startup?.abort(); this.clearStable(); }
    }
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('桌宠插件已停用');
      if (epoch !== this.epoch) return this.status();
      try {
        let launched = false;
        if (command === 'stop' || command === 'restart') {
          this.set({ ...this.state, phase: 'stopping', visible: false, suspended: false, retryAt: undefined, error: undefined });
          await this.cleanup();
          this.set({ ...this.state, phase: 'stopped', visible: false, suspended: false });
        }
        if (command !== 'stop' && command !== 'hide' && this.state.phase !== 'running') {
          if (this.cleanupBlocked) await this.cleanup();
          this.set({ ...this.state, recoveryAttempt: 0, retryAt: undefined });
          await this.launch(epoch); launched = true;
        }
        if (this.state.phase === 'running' && epoch === this.epoch && (!launched || command === 'characters')) this.bridge.control?.(command === 'characters' ? 'characters' : this.state.desiredVisible ? 'show' : 'hide');
        return this.status();
      } catch (error) {
        await this.failed(error, error instanceof NativeStartError && error.recoverable, epoch);
        return this.status();
      }
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.wanted = false; this.epoch++; this.clearRetry(); this.clearStable(); this.startup?.abort();
    this.set({ ...this.state, phase: 'stopping', visible: false, suspended: false, retryAt: undefined, error: undefined });
    await this.enqueue(async () => {
      this.bridge.removeLifecycle?.(this.changed);
      const failure = await this.cleanup().then(() => undefined, error => this.message(error));
      this.set({ ...this.state, phase: failure ? 'error' : 'stopped', visible: false, ...(failure ? { error: failure } : {}) });
      this.listeners.clear();
    });
  }
  private async launch(epoch: number): Promise<void> {
    if (this.disposed || !this.wanted || epoch !== this.epoch) return;
    const startup = new AbortController(); this.startup = startup; this.startupExit = undefined;
    this.set({ ...this.state, phase: 'starting', error: undefined, retryAt: undefined, visible: false, generation: this.state.generation + 1, visibilityRevision: 0, suspended: false });
    try { await this.withDeadline(this.bridge.start(this.options(), { signal: startup.signal, generation: this.state.generation, visible: this.state.desiredVisible }), this.limits.startTimeoutMs ?? 265_000, '桌宠启动超时', startup.signal, true); }
    catch (error) { throw this.startupExit ?? error; }
    if (startup.signal.aborted || this.disposed || epoch !== this.epoch) throw new Error('桌宠启动已取消');
    this.startup = undefined;
    this.set({ ...this.state, phase: 'running' }); this.armStable();
    // A hide/show command may have changed intent while the ready handshake was pending.
    this.bridge.control?.(this.state.desiredVisible ? 'show' : 'hide');
  }
  private async failed(error: unknown, recoverable: boolean, epoch: number): Promise<void> {
    this.startup?.abort(); this.startup = undefined; this.clearStable();
    const cleanup = await this.cleanup().then(() => '', failure => `；清理失败：${this.message(failure).slice(0, 580)}`);
    if (this.disposed || epoch !== this.epoch) return;
    const diagnostic = this.message(error).slice(0, 600 - cleanup.length) + cleanup;
    const attempt = this.state.recoveryAttempt ?? 0;
    if (!this.wanted || !recoverable || cleanup || attempt >= 3) {
      this.set({ ...this.state, phase: 'error', visible: false, suspended: false, retryAt: undefined, error: diagnostic }); return;
    }
    const delay = (this.limits.retryDelaysMs ?? [1000, 3000, 10000])[attempt]!;
    this.set({ ...this.state, phase: 'recovering', visible: false, suspended: false, recoveryAttempt: attempt + 1, retryAt: Date.now() + delay, error: diagnostic });
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.enqueue(async () => {
        if (this.disposed || !this.wanted || epoch !== this.epoch) return;
        try { await this.launch(epoch); }
        catch (failure) { await this.failed(failure, failure instanceof NativeStartError && failure.recoverable, epoch); }
      });
    }, delay);
    this.retry.unref?.();
  }
  private clearRetry(): void { clearTimeout(this.retry); this.retry = undefined; }
  private clearStable(): void { clearTimeout(this.stable); this.stable = undefined; }
  private armStable(): void {
    this.clearStable(); if (this.state.suspended) return;
    const generation = this.state.generation;
    this.stable = setTimeout(() => {
      this.stable = undefined;
      if (!this.disposed && this.state.phase === 'running' && generation === this.state.generation) this.set({ ...this.state, recoveryAttempt: 0 });
    }, this.limits.stableMs ?? 60000);
    this.stable.unref?.();
  }
  private message(error: unknown): string { return String(error instanceof Error ? error.message : error).slice(0, 600); }
  private async cleanup(): Promise<void> {
    this.cleanupBlocked = true;
    await this.withDeadline(Promise.resolve().then(() => this.bridge.dispose()), this.limits.cleanupTimeoutMs ?? 5_000, '桌宠清理超时');
    this.cleanupBlocked = false;
  }
  private withDeadline<T>(task: Promise<T>, delay: number, message: string, signal?: AbortSignal, recoverable = false): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, value?: T) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value as T);
      };
      const aborted = () => finish(new Error('桌宠启动已取消'));
      const timer = setTimeout(() => finish(new NativeStartError(message, recoverable)), delay);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      task.then(value => finish(undefined, value), error => finish(error));
    });
  }
  private set(state: PetStatus): void {
    this.state = state;
    for (const listener of this.listeners) { try { listener(this.status()); } catch { /* View errors cannot stall native cleanup. */ } }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation); this.queue = pending.catch(() => undefined); return pending;
  }
}

/** Collapse layout-breaking whitespace in display copy; identities must not use this. */
function hintText(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** Validate a session id without changing it: undefined means "no session", false rejects the hint. */
function hintSessionId(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) return false;
  return value;
}
