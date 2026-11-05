import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { ChatReceipt } from '../web/chat-contract.js';
import type { PetSnapshot, PetNotice } from './model.ts';
import type { NotificationRuntime, NotificationSnapshot, TaskNotice } from './notification-contract.ts';
import { NativeStartError, type StartLifetime, type NativeLifecycle } from './desktop-lifecycle.ts';
import { electronExecutable } from './electron-runtime.ts';
export { NativeStartError, type StartLifetime, type NativeLifecycle } from './desktop-lifecycle.ts';

import type { CompanionshipMode } from '../web/companionship.js';
import type { TextScale } from '../web/text-scale.js';

export interface DesktopOptions { size: number; npcHome?: number; npcRange?: number; textScale?: TextScale; roam: boolean; diagnostics?: boolean; companionship?: CompanionshipMode; notifications: boolean; bubbleDurationMs: number; electronPath?: string; locale?: string; systemNotifications?: boolean; reminders?: boolean; reminderDelayMs?: number; }
export interface PetBridge {
  start(options: DesktopOptions, lifetime?: StartLifetime): Promise<void>;
  update(snapshot: PetSnapshot): void;
  chatResult?(receipt: ChatReceipt): void;
  notify(notice: PetNotice | TaskNotice, runtime?: NotificationRuntime): boolean;
  notificationState?(snapshot: NotificationSnapshot): void;
  snoozeResult?(interactionId: string, ok: boolean, error?: string): void;
  presentRole?(notice: TaskNotice, runtime: NotificationRuntime): boolean;
  onAction(listener: (action: unknown) => void): void;
  removeAction(listener: (action: unknown) => void): void;
  dispose(): Promise<void>;
  configure?(options: DesktopOptions): void;
  control?(command: 'show' | 'hide' | 'characters'): void;
  focusHarness?(): void;
  onLifecycle?(listener: (state: NativeLifecycle) => void): void;
  removeLifecycle?(listener: (state: NativeLifecycle) => void): void;
}

/** Owns a separate Electron window; no changes or private IPC in the Harness desktop shell are needed. */
export class ElectronBridge extends EventEmitter implements PetBridge {
  private child?: ChildProcess;
  private latest?: PetSnapshot;
  private latestOptions?: DesktopOptions;
  private resultKey?: string;
  private closing = false;
  private preparing?: AbortController;
  private preparation?: Promise<string>;

  private generation = 0;
  private visibilityRevision = 0;
  private nativeVisible = false;
  private suspended = false;
  private screenLocked = false;
  private systemAsleep = false;
  private lastNotificationState?: NotificationSnapshot;

  async start(options: DesktopOptions, lifetime?: StartLifetime): Promise<void> {
    if (this.child || this.preparing) throw new NativeStartError('Desktop pet is already running or starting', false);
    if (lifetime?.signal.aborted) throw new Error('桌宠启动已取消');
    this.latestOptions = { ...options };
    this.closing = false;
    this.generation = lifetime?.generation ?? this.generation + 1;
    this.visibilityRevision = 0; this.nativeVisible = false;
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new NativeStartError('桌宠需要桌面显示环境。', false);
    let executable: string;
    if (options.electronPath !== undefined) executable = options.electronPath;
    else {
      const preparing = new AbortController(); this.preparing = preparing;
      const abort = () => preparing.abort();
      lifetime?.signal.addEventListener('abort', abort, { once: true });
      if (lifetime?.signal.aborted) abort();
      try {
        this.preparation = electronExecutable(preparing.signal);
        executable = await this.preparation;
        if (preparing.signal.aborted || this.closing) throw new Error('桌宠启动已取消');
      } catch (error) { throw error instanceof NativeStartError ? error : new NativeStartError(String(error).slice(0, 600), false); }
      finally { lifetime?.signal.removeEventListener('abort', abort); this.preparing = undefined; this.preparation = undefined; }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_PET_GENERATION: String(this.generation), DSH_PET_VISIBLE: lifetime?.visible === false ? '0' : '1', DSH_PET_SCREEN_LOCKED: this.screenLocked ? '1' : '0', DSH_PET_SYSTEM_ASLEEP: this.systemAsleep ? '1' : '0' };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const args = [fileURLToPath(new URL('../desktop/main.cjs', import.meta.url))];
    if (env.DSH_PET_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox');
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const generation = this.generation; this.child = child;
    let diagnostic = '', userClosed = false;
    child.stderr?.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-4000); });
    child.on('message', message => {
      if (this.child !== child || this.closing || lifetime?.signal.aborted || !isRecord(message)) return;
      if (message.type === 'closed') userClosed = true;
      if (message.type === 'action') this.emit('action', message.action);
      if (message.type === 'tray-state') this.emit('tray-state', message.state);
      if (message.type === 'tray-icon') this.emit('tray-icon', message);
      if (message.type === 'visibility' && message.generation === generation && typeof message.visible === 'boolean' && Number.isSafeInteger(message.visibilityRevision) && (message.visibilityRevision as number) > this.visibilityRevision) {
        this.visibilityRevision = message.visibilityRevision as number;
        this.nativeVisible = message.visible; this.suspended = message.suspended === true;
        if (typeof message.screenLocked === 'boolean') this.screenLocked = message.screenLocked;
        if (typeof message.systemAsleep === 'boolean') this.systemAsleep = message.systemAsleep;
        this.emit('lifecycle', { running: true, visible: this.nativeVisible, generation, visibilityRevision: this.visibilityRevision, suspended: this.suspended, ...(typeof message.desiredVisible === 'boolean' ? { desiredVisible: message.desiredVisible } : {}) });
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined; this.nativeVisible = false;
      const unexpected = !this.closing && !userClosed && !lifetime?.signal.aborted;
      const error = unexpected ? `桌宠进程已退出 (${signal ?? code}): ${diagnostic}`.slice(0, 600) : undefined;
      this.emit('lifecycle', { running: false, visible: false, generation, visibilityRevision: ++this.visibilityRevision, suspended: false, unexpected, ...(error ? { error } : {}) });
      if (error) this.emit('failure', new Error(error));
    });
    child.on('error', error => { if (this.child === child && !this.closing && !lifetime?.signal.aborted) this.emit('failure', error); });
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); child.off('message', ready); child.off('error', failed); child.off('exit', exited); lifetime?.signal.removeEventListener('abort', aborted);
        if (error) { child.kill(); reject(error); } else resolve();
      };
      const ready = (message: unknown) => {
        if (isRecord(message) && message.type === 'startup-error' && this.child === child && typeof message.error === 'string') {
          finish(new NativeStartError(message.error.slice(0, 600), message.recoverable === true)); return;
        }
        if (isRecord(message) && message.type === 'ready' && this.child === child && !lifetime?.signal.aborted) {
          this.resultKey = undefined;
          this.send({ type: 'init', options: { ...this.latestOptions, locale: this.latestOptions?.locale ?? null }, baseline: true, snapshot: this.latest && desktopSnapshot(this.latest, true) });
          if (this.lastNotificationState) this.notificationState(this.lastNotificationState);
          finish();
        }
      };
      const failed = (error: NodeJS.ErrnoException) => finish(new NativeStartError(error.message.slice(0, 600), error.code === 'EAGAIN' || error.code === 'ENOMEM'));
      const exited = (code: number | null, signal: string | null) => finish(new NativeStartError(`桌宠启动失败 (${signal ?? code}): ${diagnostic}`.slice(0, 600), true));
      const aborted = () => finish(new Error('桌宠启动已取消'));
      const timer = setTimeout(() => finish(new NativeStartError(`桌宠未能在 20 秒内启动: ${diagnostic}`.slice(0, 600), true)), 20000);
      child.on('message', ready); child.once('error', failed); child.once('exit', exited);
      lifetime?.signal.addEventListener('abort', aborted, { once: true });
      if (lifetime?.signal.aborted) aborted();
    });
  }

  update(snapshot: PetSnapshot): void {
    this.latest = snapshot;
    const key = snapshot.results.map(result => `${result.id}:${result.read}`).join('|');
    this.send({ type: 'snapshot', snapshot: desktopSnapshot(snapshot, key !== this.resultKey) });
    this.resultKey = key;
  }
  notify(notice: PetNotice | TaskNotice, runtime?: NotificationRuntime): boolean {
    if (!this.child?.connected || this.closing) return false;
    if (runtime && (!this.nativeVisible || this.suspended || runtime.generation !== this.generation || runtime.visibilityRevision !== this.visibilityRevision || !runtime.visible)) return false;
    return this.send({ type: 'notice', notice, ...(runtime ? { generation: runtime.generation, visibilityRevision: runtime.visibilityRevision } : {}) });
  }
  notificationState(snapshot: NotificationSnapshot): void { this.lastNotificationState = structuredClone(snapshot); this.send({ type: 'notification-state', snapshot }); }
  snoozeResult(interactionId: string, ok: boolean, error?: string): void { this.send({ type: 'notification-snooze-result', interactionId, ok, ...(error ? { error: error.slice(0, 600) } : {}) }); }
  presentRole(notice: TaskNotice, runtime: NotificationRuntime): boolean { return this.notify(notice, runtime); }
  chatResult(receipt: ChatReceipt): void { this.send(receipt); }
  onAction(listener: (action: unknown) => void): void { this.on('action', listener); }
  removeAction(listener: (action: unknown) => void): void { this.off('action', listener); }
  // JSON IPC omits undefined. An explicit null lets a cleared Harness
  // preference restore the renderer's automatic language instead of retaining
  // its previous locale during a merged configuration update.
  configure(options: DesktopOptions): void { this.latestOptions = { ...options }; this.send({ type: 'configure', options: { ...options, locale: options.locale ?? null } }); }
  control(command: 'show' | 'hide' | 'characters'): void { this.send({ type: 'control', command }); }
  focusHarness(): void { this.send({ type: 'control', command: 'focus-harness' }); }
  onLifecycle(listener: (state: NativeLifecycle) => void): void { this.on('lifecycle', listener); }
  removeLifecycle(listener: (state: NativeLifecycle) => void): void { this.off('lifecycle', listener); }
  private send(message: object): boolean {
    const child = this.child;
    if (!child?.connected || this.closing) return false;
    try {
      // A false Node return can mean backpressure after enqueueing. Reporting
      // rejection here would let callers send the same accepted notice again.
      child.send(message, error => { if (error && this.child === child && !this.closing) this.emit('failure', error); });
      return true;
    } catch { return false; }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.preparing?.abort();
    await this.preparation?.catch(() => undefined);
    const child = this.child;
    if (!child) return;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { if (this.child === child) this.child = undefined; return; }
    await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout>;
      const timer = setTimeout(() => { child.kill('SIGKILL'); deadline = setTimeout(() => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else reject(new Error('桌宠进程未确认退出')); }, 1000); }, 3000);
      child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
      if (child.connected) child.send({ type: 'quit' }, error => { if (error) child.kill(); }); else child.kill();
    });
    if (this.child === child) this.child = undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Stream animation updates carry metadata; full result text crosses IPC only when it changes. */
function desktopSnapshot(snapshot: PetSnapshot, includeResults: boolean) {
  const { results, ...state } = snapshot;
  return { ...state, text: state.mood === 'happy' ? '' : state.text,
    sessions: state.sessions.map(session => ({ ...session, text: session.mood === 'happy' ? '' : session.text, reply: '' })),
    ...(includeResults ? { results } : {}),
  };
}
