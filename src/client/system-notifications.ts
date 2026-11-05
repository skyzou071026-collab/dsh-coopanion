import type { DeliveryClaim, DeliveryReceipt, WebNotificationStatus } from '../notification-contract.ts';

export interface BrowserNotification {
  onshow: (() => void) | null;
  onclick: (() => void) | null;
  onerror: (() => void) | null;
  onclose?: (() => void) | null;
  close(): void;
}
export interface BrowserNotificationApi {
  new(title: string, options: { body: string; tag: string; silent: boolean }): BrowserNotification;
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}
/** Standard renderer path: the containing browser or signed DSH application owns identity. */
export class SystemNotifications {
  private readonly active = new Map<string, BrowserNotification>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly requested = new Set<string>();
  private disposed = false;
  constructor(
    private readonly api: BrowserNotificationApi | undefined,
    private readonly receipt: (value: DeliveryReceipt) => void,
    private readonly openSession: (sessionId: string) => void,
    private readonly now: () => number = Date.now,
    private readonly limits = { active: 64, tokens: 256 },
  ) {}
  status(): WebNotificationStatus {
    return { supported: !!this.api, permission: this.api?.permission ?? 'unavailable', osAuthorization: 'unknown' };
  }
  /** Call only from the user's enable action. Browser permission is distinct from OS authorization. */
  async requestPermission(): Promise<WebNotificationStatus> {
    if (!this.disposed && this.api?.permission === 'default') await this.api.requestPermission();
    return this.status();
  }
  deliver(claim: DeliveryClaim): void {
    if (this.disposed || this.requested.has(claim.token)) return;
    this.requested.add(claim.token);
    while (this.requested.size > this.limits.tokens) this.requested.delete(this.requested.values().next().value!);
    const report = (state: DeliveryReceipt['state'], detail?: string) => this.receipt({
      token: claim.token, clientId: claim.clientId, noticeId: claim.notice.id,
      generation: claim.generation, state, time: this.now(), ...(detail ? { detail } : {}),
    });
    if (this.now() >= claim.expiresAt) { report('failed', 'claim-expired'); return; }
    if (!this.api || this.api.permission !== 'granted') { report('failed', 'web-permission-unavailable'); return; }
    try {
      const notification = new this.api(claim.notice.title, { body: claim.notice.body, tag: claim.notice.id, silent: true });
      this.active.set(claim.token, notification);
      while (this.active.size > this.limits.active) this.release(this.active.keys().next().value!);
      const alive = () => !this.disposed && this.active.get(claim.token) === notification;
      let shown = false;
      notification.onshow = () => { if (alive() && !shown) { shown = true; clearTimeout(this.timers.get(claim.token)); this.timers.delete(claim.token); report('shown'); } };
      notification.onerror = () => { if (alive()) { report('failed', 'notification-error'); this.release(claim.token); } };
      notification.onclick = () => {
        if (!alive()) return;
        let detail: string | undefined;
        try { this.openSession(claim.notice.sessionId); } catch { detail = 'open-session-failed'; }
        report('clicked', detail); this.release(claim.token);
      };
      notification.onclose = () => { if (alive()) { if (!shown) report('unknown', 'notification-closed-before-show'); this.release(claim.token); } };
      report('requested');
      const timer = setTimeout(() => { this.timers.delete(claim.token); if (alive() && !shown) report('unknown', 'show-receipt-timeout'); }, 10_000);
      timer.unref?.(); this.timers.set(claim.token, timer);
    } catch { report('failed', 'notification-construction-failed'); this.release(claim.token); }
  }
  private release(token: string): void {
    clearTimeout(this.timers.get(token)); this.timers.delete(token);
    const notification = this.active.get(token);
    if (notification) notification.onshow = notification.onclick = notification.onerror = notification.onclose = null;
    this.active.delete(token);
  }
  /** Release callback ownership at the adapter's lifetime boundary; OS history stays under OS control. */
  invalidate(): void { for (const token of this.active.keys()) this.release(token); }
  /** Release callbacks while letting the operating system manage delivered notification history. */
  dispose(): void { this.disposed = true; this.invalidate(); this.requested.clear(); }
}
