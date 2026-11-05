import { expect, it, vi } from 'vitest';
import { noticeId, interactionId, notificationPreferencesSchema, notificationRequests, type DeliveryClaim } from '../src/notification-contract.ts';
import { SystemNotifications } from '../src/client/system-notifications.ts';

const claim: DeliveryClaim = { token: 'native-token', clientId: 'client-one', generation: 2, visibilityRevision: 3, expiresAt: 1000,
  notice: { id: noticeId('session:full', 1, 8, 'question', 'initial'), sessionId: 'session:full', turn: 1, seq: 8, time: 0, category: 'question', stage: 'initial', title: 'N0', body: '需要你回答', requestIds: [interactionId('session:full', 'question', 'call-full')] } };

it('preserves existing preferences and validates each RPC as an exact message', () => {
  expect(notificationPreferencesSchema.parse({ notifications: false })).toEqual({ notifications: false, systemNotifications: false, reminders: true, reminderDelayMs: 600000 });
  expect(() => notificationPreferencesSchema.parse({ reminderDelayMs: 1 })).toThrow();
  expect(() => notificationRequests.claim.parse({ clientId: 'a', generation: 2, visible: false })).toThrow();
  expect(interactionId('a:question', 'question', 'b')).not.toBe(interactionId('a', 'question', 'question:b'));
  expect(noticeId('a', 1, 8, 'question', 'initial')).not.toBe(noticeId('a', 1, 8, 'question', 'reminder'));
});

function fixture(permission: NotificationPermission = 'granted') {
  const receipts = vi.fn(), open = vi.fn(), objects: Array<{ onshow: (() => void) | null; onclick: (() => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> }> = [];
  class Api {
    static permission = permission;
    static requestPermission = vi.fn(async () => Api.permission = 'granted' as const);
    onshow = null; onclick = null; onerror = null; close = vi.fn();
    constructor(public title: string, public options: unknown) { objects.push(this); }
  }
  const service = new SystemNotifications(Api, receipts, open, () => 100);
  return { service, Api, receipts, open, objects };
}
it('separates browser permission, request, actual show and exact-session click', async () => {
  const { service, Api, receipts, open, objects } = fixture('default');
  expect(service.status()).toEqual({ supported: true, permission: 'default', osAuthorization: 'unknown' });
  expect(Api.requestPermission).not.toHaveBeenCalled();
  expect(await service.requestPermission()).toMatchObject({ permission: 'granted', osAuthorization: 'unknown' });
  service.deliver(claim); service.deliver(claim);
  expect(objects).toHaveLength(1);
  expect(receipts.mock.calls.map(c => c[0].state)).toEqual(['requested']);
  objects[0].onshow?.(); objects[0].onclick?.();
  expect(receipts.mock.calls.map(c => c[0].state)).toEqual(['requested', 'shown', 'clicked']);
  expect(open).toHaveBeenCalledExactlyOnceWith('session:full');
  service.dispose(); expect(objects[0].onclick).toBeNull(); expect(objects[0].close).not.toHaveBeenCalled();
});
it('reports denied permission, expired claims and unavailable API without a delivery claim of success', () => {
  const denied = fixture('denied'); denied.service.deliver(claim);
  expect(denied.receipts).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', detail: 'web-permission-unavailable' }));
  const expired = fixture(); expired.service.deliver({ ...claim, expiresAt: 100 }); expect(expired.objects).toHaveLength(0);
  expect(expired.receipts).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', detail: 'claim-expired' }));
  const receipts = vi.fn(), missing = new SystemNotifications(undefined, receipts, vi.fn()); missing.deliver({ ...claim, expiresAt: Number.MAX_SAFE_INTEGER });
  expect(missing.status().permission).toBe('unavailable'); expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
});
it('contains constructor failure and releases late callbacks on disposal', () => {
  class Broken { static permission = 'granted' as const; static requestPermission = vi.fn(); constructor() { throw new Error('OS failed'); } onshow = null; onclick = null; onerror = null; close() {} }
  const receipts = vi.fn(), service = new SystemNotifications(Broken, receipts, vi.fn(), () => 100); service.deliver(claim);
  expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', detail: 'notification-construction-failed' }));
  const live = fixture(); live.service.deliver(claim); const show = live.objects[0].onshow; live.service.dispose(); show?.();
  expect(live.receipts).toHaveBeenCalledTimes(1);
});

it('distinguishes snooze occurrences and complete runtime-only request identities', () => {
  expect(noticeId('session', 1, 2, 'question', 'initial')).toBe('["session",1,2,"question","initial"]');
  expect(noticeId('session', 1, 2, 'question', 'reminder', 1)).not.toBe(noticeId('session', 1, 2, 'question', 'reminder', 2));
  expect(noticeId('session', 1, 2, 'question', 'initial', 0, 'request-full-one')).not.toBe(noticeId('session', 1, 2, 'question', 'initial', 0, 'request-full-two'));
  expect(JSON.parse(noticeId('session', 1, 2, 'question', 'reminder', 2, 'request-full-one'))).toEqual(['session', 1, 2, 'question', 'reminder', 'request-full-one', 2]);
  expect(() => noticeId('session', 1, 2, 'question', 'initial', -1)).toThrow();
});
