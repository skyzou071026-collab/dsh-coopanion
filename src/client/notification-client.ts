import { deliveryClaimSchema, runtimeSchema, interactionSchema, type DeliveryClaim, type DeliveryReceipt, type NotificationPreferences, type NotificationSnapshot, type WebNotificationStatus } from '../notification-contract.ts';
import { systemNotificationCopy } from './notification-copy.ts';
import { SystemNotifications, type BrowserNotificationApi } from './system-notifications.ts';

/** All calls travel through the authenticated DSH Connection supplied by the plugin entry point. */
export interface NotificationTransport {
  state(signal: AbortSignal): Promise<NotificationSnapshot>;
  claim(value: { clientId: string; generation: number }, signal: AbortSignal): Promise<DeliveryClaim | null>;
  receipt(value: DeliveryReceipt, signal: AbortSignal): Promise<unknown>;
  snooze(value: { interactionId: string; generation: number }, signal: AbortSignal): Promise<unknown>;
}
export interface NotificationClientStatus {
  web: WebNotificationStatus;
  connected: boolean;
  delivery?: DeliveryReceipt['state'];
  /** Browser delivery and Host acceptance are independent facts. */
  receiptAccepted?: boolean;
  error?: string;
}
export interface NotificationSettings {
  subscribe(listener: () => void): () => void;
  getSnapshot(): NotificationClientStatus;
  requestPermission(): Promise<WebNotificationStatus>;
  test(): Promise<void>;
}
export interface NotificationClientOptions {
  transport: NotificationTransport;
  preferences: () => NotificationPreferences;
  openSession: (sessionId: string) => void;
  locale?: () => string;
  api?: BrowserNotificationApi;
  clientId?: string;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  /** A Host-issued, exportable source session and claim, invoked only by a user action. */
  testClaim?: (clientId: string, signal: AbortSignal) => Promise<DeliveryClaim>;
}
function parseState(value: NotificationSnapshot): NotificationSnapshot {
  if (!value || value.protocol !== 1 || !Array.isArray(value.interactions) || value.interactions.length > 1000) throw new Error('Invalid notification state');
  return { protocol: 1, runtime: runtimeSchema.parse(value.runtime), interactions: value.interactions.map(item => interactionSchema.parse(item)) };
}
/** Persistent plugin-lifecycle consumer. Settings observes it; mounting Settings never starts delivery. */
export class NotificationClient implements NotificationSettings {
  readonly clientId: string;
  private readonly system: SystemNotifications;
  private readonly listeners = new Set<() => void>();
  private statusValue: NotificationClientStatus;
  private readonly stop = new AbortController();
  private readonly controllers = new Set<AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private readonly receipts: DeliveryReceipt[] = [];
  private flushing?: Promise<void>;
  private readonly now: () => number;
  constructor(private readonly options: NotificationClientOptions) {
    this.now = options.now ?? Date.now;
    this.clientId = options.clientId ?? `coopanion-${globalThis.crypto.randomUUID()}`;
    this.system = new SystemNotifications(options.api, receipt => this.enqueue(receipt), options.openSession, this.now);
    this.statusValue = { web: this.system.status(), connected: false };
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): NotificationClientStatus => this.statusValue;
  private update(value: Partial<NotificationClientStatus>): void {
    this.statusValue = { ...this.statusValue, ...value, web: this.system.status() };
    for (const listener of this.listeners) listener();
  }
  /** Bound each request even when a transport neglects AbortSignal. */
  private async request<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stop.signal.aborted) throw new Error('Notification client disposed');
    const controller = new AbortController(); this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Notification request timed out')); }, this.options.timeoutMs ?? 5000);
      controller.signal.addEventListener('abort', () => reject(new Error('Notification request cancelled')), { once: true });
    });
    try { return await Promise.race([call(controller.signal), timeout]); }
    finally { clearTimeout(timer!); this.controllers.delete(controller); }
  }
  private connected(): void {
    // A pet restart revokes new delivery, while already-requested OS objects
    // retain their exact source mapping and report evidence for their own claim.
    this.update({ connected: true, error: undefined });
  }
  private eligible(state: NotificationSnapshot): boolean {
    const prefs = this.options.preferences(), runtime = state.runtime;
    return prefs.notifications && prefs.systemNotifications && runtime.phase === 'running' && runtime.visibilityRevision > 0 && !runtime.visible && !runtime.suspended;
  }
  private async deliver(value: DeliveryClaim): Promise<void> {
    const claim = deliveryClaimSchema.parse(value);
    if (claim.clientId !== this.clientId) throw new Error('Notification claim belongs to another client');
    const state = parseState(await this.request(signal => this.options.transport.state(signal)));
    this.connected();
    const requestsValid = claim.notice.requestIds.every(id => state.interactions.some(item => item.id === id && item.sessionId === claim.notice.sessionId && item.state !== 'settled'));
    if (!this.eligible(state) || !requestsValid || claim.generation !== state.runtime.generation || claim.visibilityRevision !== state.runtime.visibilityRevision) {
      this.enqueue({ token: claim.token, clientId: this.clientId, noticeId: claim.notice.id, generation: claim.generation, state: 'failed', time: this.now(), detail: 'delivery-state-changed' });
      return;
    }
    this.system.deliver({ ...claim, notice: systemNotificationCopy(claim.notice, this.options.locale?.() ?? 'zh') });
  }
  private enqueue(receipt: DeliveryReceipt): void {
    if (this.stop.signal.aborted) return;
    this.receipts.push(receipt);
    // Failed/unknown transport remains visible locally and cannot accumulate unbounded work.
    if (this.receipts.length > 128) { this.receipts.shift(); this.update({ error: 'Notification receipt backlog exceeded' }); }
    this.update({ delivery: receipt.state, receiptAccepted: undefined, ...(receipt.detail === 'open-session-failed' ? { error: 'Unable to open the source session' } : {}) });
  }
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushReceipts().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async flushReceipts(): Promise<void> {
    for (let n = 0; n < 8 && this.receipts.length; n++) {
      const receipt = this.receipts[0]!;
      const result = await this.request(signal => this.options.transport.receipt(receipt, signal));
      if (this.receipts[0] === receipt) this.receipts.shift();
      if (result && typeof result === 'object' && 'accepted' in result) {
        const accepted = result.accepted === true;
        this.update({ receiptAccepted: accepted, ...(!accepted ? { error: 'Host rejected the notification receipt' } : {}) });
      }
    }
  }
  start(): () => void {
    if (this.started || this.stop.signal.aborted) return () => this.dispose();
    this.started = true; void this.poll(); return () => this.dispose();
  }
  private async poll(): Promise<void> {
    try {
      await this.flush();
      const state = parseState(await this.request(signal => this.options.transport.state(signal))); this.connected();
      if (this.eligible(state) && this.system.status().permission === 'granted') {
        const claim = await this.request(signal => this.options.transport.claim({ clientId: this.clientId, generation: state.runtime.generation }, signal));
        if (claim && !this.stop.signal.aborted) await this.deliver(claim);
      }
      await this.flush();
    } catch (error) {
      if (!this.stop.signal.aborted) this.update({ connected: false, error: String(error instanceof Error ? error.message : error).slice(0, 600) });
    } finally { if (!this.stop.signal.aborted) this.timer = setTimeout(() => void this.poll(), this.options.pollMs ?? 750); }
  }
  async requestPermission(): Promise<WebNotificationStatus> {
    try { const web = await this.system.requestPermission(); this.update({ error: undefined }); return web; }
    catch (error) { this.update({ error: String(error instanceof Error ? error.message : error).slice(0, 600) }); throw error; }
  }
  async test(): Promise<void> {
    if (!this.options.testClaim) throw new Error('Notification test unavailable');
    const claim = await this.request(signal => this.options.testClaim!(this.clientId, signal));
    await this.deliver(claim); await this.flush();
  }
  async snooze(interactionId: string): Promise<void> {
    const state = parseState(await this.request(signal => this.options.transport.state(signal))); this.connected();
    if (!state.interactions.some(item => item.id === interactionId && item.state !== 'settled')) throw new Error('Interaction is no longer pending');
    await this.request(signal => this.options.transport.snooze({ interactionId, generation: state.runtime.generation }, signal));
  }
  dispose(): void {
    if (this.stop.signal.aborted) return;
    this.stop.abort(); clearTimeout(this.timer);
    for (const controller of this.controllers) controller.abort(); this.controllers.clear();
    this.system.dispose(); this.receipts.length = 0; this.listeners.clear();
  }
}
