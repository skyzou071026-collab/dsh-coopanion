import { afterEach, expect, it, vi } from 'vitest';
import { NotificationClient } from '../src/client/notification-client.ts';
import { SystemNotifications } from '../src/client/system-notifications.ts';
import type { DeliveryClaim, DeliveryReceipt, NotificationSnapshot } from '../src/notification-contract.ts';

const state: NotificationSnapshot = { protocol: 1, runtime: { phase: 'running', visible: false, generation: 3, visibilityRevision: 2, suspended: false }, interactions: [{ id: 'request-full', nativeId: 'native-full', sessionId: 'session-full-not-prefix', kind: 'question', turn: 1, seq: 9, createdAt: 1, preview: 'Choose?', state: 'open', dueAt: 200, automaticReminders: 0 }] };
const claim: DeliveryClaim = { token: 'lease-full', clientId: 'ui-one', generation: 3, visibilityRevision: 2, expiresAt: 20000,
  notice: { id: 'notice-full', sessionId: 'session-full-not-prefix', turn: 1, seq: 9, time: 1, category: 'question', stage: 'initial', title: 'Question', body: 'Choose?', requestIds: ['request-full'] } };
function fixture() {
  vi.useFakeTimers();
  const receipt = vi.fn(async (_value: DeliveryReceipt, _signal: AbortSignal): Promise<unknown> => undefined), open = vi.fn();
  const objects: Api[] = [];
  class Api {
    static permission: NotificationPermission = 'granted'; static requestPermission = vi.fn(async () => Api.permission);
    onshow: (() => void) | null = null; onclick: (() => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null; close = vi.fn();
    constructor(public title: string, public options: unknown) { objects.push(this); }
  }
  let locale = 'en-US';
  let current = structuredClone(state), next: DeliveryClaim | null = structuredClone(claim), prefs = { notifications: true, systemNotifications: true, reminders: true, reminderDelayMs: 600000 };
  const transport = { state: vi.fn(async (_signal: AbortSignal) => current), claim: vi.fn(async (_value: { clientId: string; generation: number }, _signal: AbortSignal) => { const result = next; next = null; return result; }), receipt,
    snooze: vi.fn(async (_value: { interactionId: string; generation: number }, _signal: AbortSignal) => {}) };
  const service = new NotificationClient({ transport, preferences: () => prefs, api: Api, openSession: open, locale: () => locale, clientId: 'ui-one', now: () => 100, pollMs: 100, timeoutMs: 1000,
    testClaim: vi.fn(async () => structuredClone(claim)) });
  return { service, transport, Api, objects, open, prefs, current, setLocale: (value: string) => { locale = value; }, setState: (value: NotificationSnapshot) => { current = value; }, setClaim: (value: DeliveryClaim) => { next = value; } };
}
afterEach(() => { vi.useRealTimers(); });
const tick = async (ms = 0) => vi.advanceTimersByTimeAsync(ms);

it('runs outside Settings and reports only requested until the browser supplies show/click', async () => {
  const f = fixture(); f.service.start(); await tick();
  expect(f.objects).toHaveLength(1); expect(f.transport.receipt.mock.calls.map(call => (call[0] as any).state)).toEqual(['requested']);
  f.objects[0]!.onshow!(); f.objects[0]!.onshow!(); await tick(100);
  expect(f.service.getSnapshot()).toMatchObject({ connected: true, delivery: 'shown', web: { osAuthorization: 'unknown' } });
  f.objects[0]!.onclick!(); await tick(100); expect(f.open).toHaveBeenCalledExactlyOnceWith(claim.notice.sessionId);
  expect(f.objects[0]!.onclick).toBeNull(); expect(f.objects[0]!.close).not.toHaveBeenCalled();
  f.service.dispose();
});
it('does not claim while visible, stopped, suspended, permission-denied or opted out', async () => {
  for (const mode of ['visible', 'stopped', 'suspended', 'denied', 'opted-out', 'no-visibility-ack']) {
    const f = fixture();
    if (mode === 'no-visibility-ack') f.current.runtime.visibilityRevision = 0;
    if (mode === 'visible') f.current.runtime.visible = true;
    if (mode === 'stopped') f.current.runtime.phase = 'stopped';
    if (mode === 'suspended') f.current.runtime.suspended = true;
    if (mode === 'denied') f.Api.permission = 'denied';
    if (mode === 'opted-out') f.prefs.systemNotifications = false;
    f.service.start(); await tick(); expect(f.transport.claim).not.toHaveBeenCalled(); expect(f.objects).toHaveLength(0); f.service.dispose();
  }
});
it('rechecks visibility and generation after claiming; a visible pet prevents system delivery', async () => {
  const f = fixture(); f.transport.state.mockResolvedValueOnce(state).mockResolvedValueOnce({ ...state, runtime: { ...state.runtime, visible: true, visibilityRevision: 3 } });
  f.service.start(); await tick(); expect(f.objects).toHaveLength(0);
  expect(f.transport.receipt).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', detail: 'delivery-state-changed' }), expect.any(AbortSignal)); f.service.dispose();
  const newer = fixture(); newer.setClaim({ ...claim, generation: 2 }); newer.service.start(); await tick(); expect(newer.objects).toHaveLength(0); newer.service.dispose();
});
it('rechecks request settlement after claiming and rejects a changed reminder group before construction', async () => {
  for (const grouped of [false, true]) {
    const f = fixture();
    if (grouped) f.setClaim({ ...claim, notice: { ...claim.notice, requestIds: ['request-full', 'request-removed'] } });
    f.transport.state.mockResolvedValueOnce(state).mockResolvedValueOnce({ ...state, interactions: grouped ? state.interactions : [] });
    f.service.start(); await tick();
    expect(f.objects).toHaveLength(0);
    expect(f.transport.receipt).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', detail: 'delivery-state-changed' }), expect.any(AbortSignal));
    f.service.dispose();
  }
});
it('keeps a requested notification clickable and records late native receipts after a pet restart', async () => {
  const f = fixture(); f.service.start(); await tick();
  const notification = f.objects[0]!;
  f.current.runtime.generation++;
  await tick(100);
  expect(notification.onshow).not.toBeNull(); expect(notification.onclick).not.toBeNull();
  notification.onshow!(); await tick(100);
  notification.onclick!(); await tick(100);
  expect(f.open).toHaveBeenCalledExactlyOnceWith(claim.notice.sessionId);
  expect(f.transport.receipt.mock.calls.map(call => call[0].state)).toEqual(['requested', 'shown', 'clicked']);
  expect(f.transport.receipt.mock.calls.every(call => call[0].generation === claim.generation && call[0].token === claim.token)).toBe(true);
  expect(f.objects).toHaveLength(1); f.service.dispose();
});
it('rejects claims for another client and contains malformed state', async () => {
  const f = fixture(); f.setClaim({ ...claim, clientId: 'other' }); f.service.start(); await tick();
  expect(f.objects).toHaveLength(0); expect(f.service.getSnapshot().error).toMatch(/another client/); f.service.dispose();
  const broken = fixture(); broken.transport.state.mockResolvedValue({ ...state, protocol: 0 } as any); broken.service.start(); await tick();
  expect(broken.service.getSnapshot()).toMatchObject({ connected: false, error: 'Invalid notification state' }); broken.service.dispose();
});
it('keeps requested source callbacks across reconnect, resumes polling and aborts requests on disposal', async () => {
  const f = fixture(); f.service.start(); await tick(); const click = f.objects[0]!.onclick;
  f.transport.state.mockRejectedValueOnce(new Error('Disconnected')); await tick(100); expect(f.objects[0]!.onclick).not.toBeNull(); click!(); expect(f.open).toHaveBeenCalledExactlyOnceWith(claim.notice.sessionId);
  await tick(100); expect(f.service.getSnapshot().connected).toBe(true);
  f.setClaim({ ...claim, token: 'second' }); await tick(100); const show = f.objects[1]!.onshow;
  f.current.runtime.generation++; await tick(100); show!(); expect(f.service.getSnapshot().delivery).toBe('shown');
  f.transport.state.mockImplementation(async signal => new Promise<NotificationSnapshot>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
  await tick(100); f.service.dispose(); await tick(); expect(f.transport.state.mock.calls.at(-1)?.[0].aborted).toBe(true);
});
it('bounds hung requests, retries failed receipts, and serializes test/poll receipt flushes', async () => {
  const f = fixture(); f.transport.state.mockImplementationOnce(async () => new Promise<NotificationSnapshot>(() => {})); f.service.start(); await tick(1001);
  expect(f.service.getSnapshot().connected).toBe(false); expect(f.service.getSnapshot().error).toMatch(/timed out|cancelled/);
  f.transport.receipt.mockRejectedValueOnce(new Error('offline')); await tick(100); expect(f.service.getSnapshot().delivery).toBe('requested'); await tick(100);
  expect(f.transport.receipt.mock.calls.filter(call => (call[0] as any).state === 'requested')).toHaveLength(2);
  f.service.dispose();
});
it('applies user permission requests only on explicit action and validates snooze against live exact identities', async () => {
  const f = fixture(); f.Api.permission = 'default'; f.service.start(); await tick(); expect(f.Api.requestPermission).not.toHaveBeenCalled();
  await f.service.requestPermission(); expect(f.Api.requestPermission).toHaveBeenCalledTimes(1);
  f.current.interactions = [{ id: 'request-full', nativeId: 'native-full', sessionId: claim.notice.sessionId, kind: 'question', turn: 1, seq: 9, createdAt: 1, preview: 'Choose?', state: 'continued', dueAt: 200, automaticReminders: 1 }];
  await f.service.snooze('request-full'); expect(f.transport.snooze).toHaveBeenCalledWith({ interactionId: 'request-full', generation: 3 }, expect.any(AbortSignal));
  await expect(f.service.snooze('request')).rejects.toThrow('no longer pending'); expect(f.transport.snooze).toHaveBeenCalledTimes(1); f.service.dispose();
});
it('reports unknown without a show receipt and bounds notification callbacks while preserving OS history', async () => {
  const f = fixture(), receipt = vi.fn(); const system = new SystemNotifications(f.Api, receipt, f.open, () => 100, { active: 2, tokens: 4 });
  system.deliver(claim); await tick(10000); expect(receipt).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unknown' }));
  const late = f.objects[0]!.onclick;
  system.deliver({ ...claim, token: 'second' }); system.deliver({ ...claim, token: 'third' });
  expect(f.objects[0]!.onclick).toBeNull(); late!(); expect(f.open).not.toHaveBeenCalled();
  f.objects[1]!.onclose!(); expect(f.objects[1]!.onclick).toBeNull(); system.dispose(); expect(f.objects.every(object => object.onclick === null)).toBe(true);
  expect(f.objects.every(object => object.close.mock.calls.length === 0)).toBe(true); f.service.dispose();
});

it('contains source-session navigation failure and keeps the native click receipt truthful', () => {
  const f = fixture(), receipt = vi.fn(), system = new SystemNotifications(f.Api, receipt, () => { throw new Error('deleted source'); }, () => 100);
  system.deliver(claim);
  expect(() => f.objects[0]!.onclick!()).not.toThrow();
  expect(receipt).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'clicked', detail: 'open-session-failed' }));
  expect(f.objects[0]!.onclick).toBeNull(); system.dispose(); f.service.dispose();
});

it('localizes system application copy at delivery time without translating user previews or changing identities', async () => {
  const f = fixture(); f.service.start(); await tick();
  expect(f.objects[0]!.title).toBe('There is a question for you');
  expect(f.objects[0]!.options).toMatchObject({ body: 'Choose?', tag: claim.notice.id });
  f.setLocale('zh-CN'); f.setClaim({ ...claim, token: 'locale-two', notice: { ...claim.notice, id: 'localized-second', body: 'Keep this English user question 原样' } });
  await tick(100);
  expect(f.objects[1]!.title).toBe('有个问题想问你'); expect(f.objects[1]!.options).toMatchObject({ body: 'Keep this English user question 原样', tag: 'localized-second' });
  f.current.interactions = ['one', 'two'].map(id => ({ ...state.interactions[0]!, id, nativeId: id }));
  f.setClaim({ ...claim, token: 'reminder', notice: { ...claim.notice, id: 'reminder-full', stage: 'reminder', requestIds: ['one', 'two'] } }); await tick(100);
  expect(f.objects[2]!.title).toBe('有 2 件事，还等你看看'); expect(f.objects[2]!.options).toMatchObject({ body: '有 2 件事，还等你看看' });
  f.objects[2]!.onclick!(); expect(f.open).toHaveBeenCalledExactlyOnceWith(claim.notice.sessionId); f.service.dispose();
});
it('does not equate a browser show callback with Host acceptance or retry rejected receipts', async () => {
  const f = fixture(); f.transport.receipt.mockResolvedValue({ accepted: false }); f.service.start(); await tick();
  expect(f.service.getSnapshot()).toMatchObject({ delivery: 'requested', receiptAccepted: false });
  await tick(100); expect(f.service.getSnapshot().receiptAccepted).toBe(false);
  expect(f.transport.receipt).toHaveBeenCalledTimes(1); expect(f.objects).toHaveLength(1);
  f.objects[0]!.onshow!(); await tick(100);
  expect(f.service.getSnapshot()).toMatchObject({ delivery: 'shown', receiptAccepted: false });
  expect(f.transport.receipt).toHaveBeenCalledTimes(2); expect(f.objects).toHaveLength(1); f.service.dispose();
});

import { systemNotificationCopy } from '../src/client/notification-copy.ts';
it('keeps initial completed/approval/question/error preview bytes and gives stop/recovery/reminder events bilingual short copy', () => {
  for (const category of ['reply', 'goal-progress', 'completed', 'approval', 'question', 'error'] as const) {
    const notice = { ...claim.notice, category, body: '用户原文 English\n🐳' };
    expect(systemNotificationCopy(notice, 'en').body).toBe(notice.body);
    expect(systemNotificationCopy(notice, 'zh').body).toBe(notice.body);
  }
  for (const category of ['stopped', 'interrupted', 'blocked', 'max-tokens'] as const) {
    const notice = { ...claim.notice, category, body: 'Host diagnostic text' };
    const zh = systemNotificationCopy(notice, 'zh'), en = systemNotificationCopy(notice, 'en');
    expect(zh.title).not.toBe(en.title); expect(en.body).toBe(en.title); expect(zh.body).toBe(zh.title);
    expect(en).toMatchObject({ id: notice.id, sessionId: notice.sessionId, requestIds: notice.requestIds });
  }
});

it('localizes goal completion and round replies without losing exact goal provenance', () => {
  for (const [category, title] of [['reply', 'This turn’s reply is ready'], ['goal-progress', 'Goal still in progress'], ['completed', 'Goal completed']] as const) {
    const notice = { ...claim.notice, category, goal: { id: 'goal-complete-identity', revision: 17, round: 9 } };
    expect(systemNotificationCopy(notice, 'en')).toMatchObject({ title, goal: notice.goal, id: notice.id });
  }
});
