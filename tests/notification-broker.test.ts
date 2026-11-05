import { expect, it, vi } from 'vitest';
import { SessionId, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types';
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { NotificationBroker, type BrokerClock, type NotificationEvent } from '../src/notification-broker.ts';
import { interactionId, type DeliveryClaim, type DeliveryReceipt, type NotificationRuntime, type TaskNotice } from '../src/notification-contract.ts';
function session(id = 'full:session:id'): Pick<Session, 'id' | 'header'> {
  return { id: SessionId(id), header: { version: 4, id: SessionId(id), createdAt: 0, isSeeded: false, cwd: '/project/demo' } };
}
function event<T extends SessionEvent['type']>(type: T, seq: number, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: 1000 + seq } as SessionEvent;
}
function clock() {
  let now = 1000, token = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const api: BrokerClock = { now: () => now, setTimeout: (callback, delay) => { timers.set(++token, { at: now + delay, callback }); return token; }, clearTimeout: handle => { timers.delete(handle as number); } };
  return { api, timers, advance: (ms: number) => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); } } };
}
const runtime = (patch: Partial<NotificationRuntime> = {}): NotificationRuntime => ({ phase: 'running', generation: 1, visibilityRevision: 1, visible: false, suspended: false, ...patch });
function fixture(visible = false) {
  const time = clock(), presentRole = vi.fn((_notice: TaskNotice, _runtime: NotificationRuntime) => true), broker = new NotificationBroker({ clock: time.api, presentRole });
  broker.preferences({ systemNotifications: true }); broker.runtime(runtime({ visible }));
  return { broker, time, presentRole, s: session() };
}
function asked(broker: NotificationBroker, s: ReturnType<typeof session>, nativeId = 'native-full', seq = 1) {
  broker.consume(s, event('turn/start', 0, { turn: 1 }));
  broker.consume(s, event('approval/asked', seq, { id: ApprovalRequestId(nativeId), toolName: 'bash', callId: ToolCallId('call:full') }));
  return interactionId(s.id, 'approval', nativeId);
}
function receipt(claim: DeliveryClaim, state: DeliveryReceipt['state']): DeliveryReceipt { return { token: claim.token, clientId: claim.clientId, noticeId: claim.notice.id, generation: claim.generation, state, time: 1000 }; }
it('selects one acknowledged channel, uses nonpredictable tokens and binds exact client/notice/generation', () => {
  const { broker, s, presentRole } = fixture(); asked(broker, s);
  const claim = broker.claim('client-a', 1)!; expect(claim.token).toMatch(/^[0-9a-f-]{36}$/);
  expect(broker.claim('client-b', 1)).toBeNull();
  expect(broker.receipt({ ...receipt(claim, 'requested'), clientId: 'client-b' })).toBe(false);
  expect(broker.receipt({ ...receipt(claim, 'requested'), noticeId: claim.notice.id.slice(0, -1) })).toBe(false);
  expect(broker.receipt(receipt(claim, 'shown'))).toBe(false);
  expect(broker.receipt(receipt(claim, 'requested'))).toBe(true);
  expect(broker.receipt(receipt(claim, 'requested'))).toBe(false);
  expect(broker.receipt(receipt(claim, 'shown'))).toBe(true);
  expect(broker.receipt(receipt(claim, 'clicked'))).toBe(true);
  expect(broker.snapshot().interactions).toHaveLength(1); // Viewing is never a decision.
  expect(presentRole).not.toHaveBeenCalled();
  const role = fixture(true); asked(role.broker, role.s);
  expect(role.presentRole).toHaveBeenCalledOnce(); expect(role.broker.claim('client', 1)).toBeNull();
});
it('requires a native visibility revision, rejecting stale native generations and fake same-revision visibility', () => {
  const broker = new NotificationBroker(); broker.preferences({ systemNotifications: true });
  broker.runtime(runtime({ visibilityRevision: 0 })); asked(broker, session());
  expect(broker.claim('client', 1)).toBeNull();
  expect(broker.runtime(runtime())).toBe(true);
  expect(broker.runtime(runtime({ visible: true }))).toBe(false);
  expect(broker.runtime(runtime({ generation: 0, visibilityRevision: 3 }))).toBe(false);
  broker.dispose();
});
it('records an unknown outcome when visibility or settlement races a claimed client, preserving one channel', () => {
  const { broker, s, presentRole } = fixture(); asked(broker, s);
  const claim = broker.claim('client', 1)!;
  broker.runtime(runtime({ visible: true, visibilityRevision: 2 }));
  expect(broker.history()[0].state).toBe('unknown');
  expect(broker.receipt(receipt(claim, 'requested'))).toBe(true);
  expect(broker.receipt(receipt(claim, 'shown'))).toBe(true);
  expect(presentRole).not.toHaveBeenCalled();
  const other = fixture(); asked(other.broker, other.s);
  const pending = other.broker.claim('client', 1)!;
  other.broker.consume(other.s, event('approval/decided', 2, { id: ApprovalRequestId('native-full'), outcome: 'allowed-once' }));
  expect(other.broker.history()[0].state).toBe('unknown');
  expect(other.broker.receipt(receipt(pending, 'requested'))).toBe(true);
  expect(other.broker.snapshot().interactions).toEqual([]);
});
it('never reclaims a claim after expiry and records delayed requested/shown as evidence without redelivery', () => {
  const { broker, time, s } = fixture(); asked(broker, s);
  const expired = broker.claim('a', 1)!; time.advance(15_000);
  expect(broker.history()[0].state).toBe('unknown');
  expect(broker.claim('b', 1)).toBeNull();
  expect(broker.receipt(receipt(expired, 'requested'))).toBe(true);
  time.advance(15_000); expect(broker.history()[0].state).toBe('unknown');
  expect(broker.receipt(receipt(expired, 'shown'))).toBe(true);
  expect(broker.claim('c', 1)).toBeNull();
});
it('settles approvals by native id and late question replies by full call id, retaining continued after turn/end', () => {
  const { broker, s } = fixture(); const id = asked(broker, s, 'native-full');
  broker.consume(s, event('approval/decided', 2, { id: ApprovalRequestId('native'), outcome: 'rejected' }));
  expect(broker.snapshot().interactions[0].id).toBe(id);
  broker.consume(s, event('tool/call', 3, { turn: 1, step: 1, callId: ToolCallId('question-full'), name: 'ask_user_question', arguments: '{}' }));
  broker.questions(s, { active: [{ callId: 'question-full', state: 'open', questions: [{ question: 'Which?' }] }] });
  broker.consume(s, event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }));
  broker.questions(s, { active: [{ callId: 'question-full', state: 'continued', questions: [{ question: 'Which?' }] }] });
  expect(broker.snapshot().interactions).toMatchObject([{ nativeId: 'question-full', state: 'continued' }]);
  broker.consume(s, { type: 'user/message', seq: SessionSeq(5), time: 1005, data: { source: { kind: 'user-question-reply', callId: 'question', outcome: 'answered' } } } as unknown as SessionEvent);
  expect(broker.snapshot().interactions).toHaveLength(1);
  broker.consume(s, { type: 'user/message', seq: SessionSeq(6), time: 1006, data: { source: { kind: 'user-question-reply', callId: 'question-full', outcome: 'answered' } } } as unknown as SessionEvent);
  expect(broker.snapshot().interactions).toHaveLength(0);
});
it('reminds once after ten minutes, groups simultaneous requests, and supports a separate snoozed occurrence', () => {
  const { broker, s, time, presentRole } = fixture(true);
  const id = asked(broker, s); asked(broker, s, 'second', 2);
  time.advance(599_999); expect(presentRole).toHaveBeenCalledTimes(2);
  time.advance(1); expect(presentRole).toHaveBeenCalledTimes(3);
  expect(presentRole.mock.calls.at(-1)![0].requestIds).toHaveLength(2);
  expect(broker.snapshot().interactions.every(r => r.automaticReminders === 1)).toBe(true);
  time.advance(600_000); expect(presentRole).toHaveBeenCalledTimes(3);
  expect(broker.snooze(id, 1)).toBe(true); time.advance(600_000);
  expect(presentRole).toHaveBeenCalledTimes(4);
  expect(JSON.parse(presentRole.mock.calls.at(-1)![0].id).at(-1)).toBe(1);
});
it('rechecks a settled request in a grouped reminder and cancellation removes timers/listeners', () => {
  const { broker, s, time, presentRole } = fixture(true); asked(broker, s); asked(broker, s, 'second', 2);
  broker.consume(s, event('approval/decided', 3, { id: ApprovalRequestId('native-full'), outcome: 'cancelled' }));
  time.advance(600_000); expect(presentRole.mock.calls.at(-1)![0].requestIds).toEqual([interactionId(s.id, 'approval', 'second')]);
  const controller = new AbortController();
  broker.question(s, { nativeId: 'blocking-runtime', turn: 1, seq: 3, preview: 'Blocking?', signal: controller.signal });
  controller.abort(); expect(broker.snapshot().interactions.some(r => r.nativeId === 'blocking-runtime')).toBe(false);
  broker.dispose(); expect(time.timers.size).toBe(0); time.advance(600_000); expect(broker.snapshot().interactions).toEqual([]);
});
it('restores pending entrances without stale initial or automatic notices, while explicit snooze is available', () => {
  const { broker, s, time, presentRole } = fixture(true);
  broker.restore({ ...s, snapshotEvents: () => [event('turn/start', 0, { turn: 1 }), event('tool/call', 1, { turn: 1, step: 1, callId: ToolCallId('persisted'), name: 'ask_user_question', arguments: '{}' })] }, { active: [{ callId: 'persisted', state: 'continued', questions: [{ question: 'Restored?' }] }] });
  time.advance(600_000); expect(presentRole).not.toHaveBeenCalled();
  const id = broker.snapshot().interactions[0].id;
  expect(broker.snooze(id, 1)).toBe(true); time.advance(600_000); expect(presentRole).toHaveBeenCalledOnce();
});
it('cancels claims/timers across stop or suspend and rejects old-generation callbacks after restart', () => {
  const { broker, s, time, presentRole } = fixture(); asked(broker, s);
  const claim = broker.claim('client', 1)!;
  broker.runtime(runtime({ phase: 'stopped' }));
  expect(time.timers.size).toBe(0); expect(broker.receipt(receipt(claim, 'requested'))).toBe(true);
  time.advance(600_000); expect(broker.claim('client', 1)).toBeNull();
  broker.runtime(runtime({ generation: 2, visibilityRevision: 0 })); expect(broker.claim('client', 2)).toBeNull();
  broker.runtime(runtime({ generation: 2 }));
  expect(broker.receipt(receipt(claim, 'shown'))).toBe(true);
  broker.runtime(runtime({ generation: 2, suspended: true })); time.advance(600_000); expect(presentRole).not.toHaveBeenCalled();
  broker.runtime(runtime({ generation: 2 })); broker.remove(s.id); time.advance(600_000); expect(broker.snapshot().interactions).toEqual([]);
});
it('classifies actual turn outcomes, drops subagents/duplicates/forked, and contains view failures', () => {
  const time = clock(), presentRole = vi.fn(() => { throw new Error('view gone'); });
  const broker = new NotificationBroker({ clock: time.api, presentRole, changed: () => { throw new Error('view gone'); } });
  broker.runtime(runtime({ visible: true })); const s = session();
  const reasons = ['completed', 'error', 'aborted', 'interrupted', 'blocked', 'max-tokens', 'forked'] as const;
  for (const [i, kind] of reasons.entries()) {
    const e = event('turn/end', i + 1, { turn: i + 1, reason: kind === 'error' ? { kind, error: { code: 'UNKNOWN', message: 'failed' } } : kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind } });
    broker.consume(s, e); broker.consume(s, e);
  }
  expect(broker.history().map(h => h.notice.category)).toEqual(['reply', 'error', 'stopped', 'interrupted', 'blocked', 'max-tokens']);
  broker.consume({ ...session('child'), header: { ...s.header, origin: 'subagent' } }, event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }));
  expect(broker.history()).toHaveLength(6);
});
it('does not expose private reasoning and retains only confirmed assistant text in completion previews', () => {
  const { broker, s } = fixture(); broker.consume(s, event('turn/start', 0, { turn: 1 }));
  broker.consume(s, event('assistant/message', 1, { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'confirmed' }], source: { provider: 'test', model: 'test' } }) }));
  broker.consume(s, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }));
  expect(broker.claim('client', 1)!.notice.body).toBe('confirmed');
});
it('uses exact tool/PTC event provenance, never projection-time watermarks or partial ids', () => {
  const { broker, s } = fixture();
  broker.consume(s, event('turn/start', 0, { turn: 1 }));
  broker.consume(s, event('tool/call', 1, { turn: 1, step: 1, callId: ToolCallId('question-full'), name: 'ask_user_question', arguments: '{}' }));
  broker.consume(s, event('turn/start', 2, { turn: 2 }));
  broker.questions(s, { active: [{ callId: 'question-full', state: 'continued', questions: [{ question: 'Source?' }] }, { callId: 'question', state: 'continued', questions: [{ question: 'Bad identity?' }] }] });
  expect(broker.snapshot().interactions).toMatchObject([{ nativeId: 'question-full', turn: 1, seq: 1, createdAt: 1001 }]);
  expect(broker.diagnostics()).toEqual([{ code: 'question-source-unavailable', sessionId: s.id, nativeId: 'question' }]);
  broker.consume(s, { type: 'tool/ptc-dispatch', seq: 3, time: 1003, data: { name: 'ask_user_question', subCallId: 'full-sub-call' } });
  broker.questions(s, { active: [{ callId: 'full-sub-call', state: 'continued', questions: [{ question: 'PTC?' }] }] });
  expect(broker.snapshot().interactions).toMatchObject([{ nativeId: 'full-sub-call', turn: 2, seq: 3 }]);
});
it('restores the original turn of an older continued PTC question after its provenance cache is evicted', () => {
  const { broker, s } = fixture();
  const history: NotificationEvent[] = [
    event('turn/start', 0, { turn: 1 }),
    { type: 'tool/ptc-dispatch', seq: 1, time: 1001, data: { name: 'ask_user_question', subCallId: 'old-ptc-full-call' } },
    event('turn/start', 2, { turn: 2 }),
  ];
  for (let n = 0; n < 201; n++) history.push(event('tool/call', n + 3, { turn: 2, step: n + 1, callId: ToolCallId(`new-call-${n}`), name: 'ask_user_question', arguments: '{}' }));
  broker.restore({ ...s, snapshotEvents: () => history as readonly SessionEvent[] }, { active: [{ callId: 'old-ptc-full-call', state: 'continued', questions: [{ question: 'Earlier turn?' }] }] });
  expect(broker.snapshot().interactions).toMatchObject([{ nativeId: 'old-ptc-full-call', turn: 1, seq: 1, createdAt: 1001 }]);
});
it('pauses timer execution during suspend, rechecks expired questions on wake and honors independent reminder toggles', () => {
  const { broker, s, time, presentRole } = fixture(true); asked(broker, s);
  time.advance(300_000); broker.runtime(runtime({ visible: true, suspended: true }));
  expect(time.timers.size).toBe(0); time.advance(600_000); expect(presentRole).toHaveBeenCalledOnce();
  broker.runtime(runtime({ visible: true })); expect(presentRole).toHaveBeenCalledTimes(2);
  const other = fixture(); asked(other.broker, other.s); other.time.advance(600_000);
  expect(other.broker.history().at(-1)!.notice.stage).toBe('reminder');
  other.broker.preferences({ reminders: false });
  const claim = other.broker.claim('client', 1)!; expect(claim.notice.stage).toBe('initial');
  expect(other.broker.claim('client2', 1)).toBeNull();
});
it('snoozing postpones an unclaimed request, and disconnect turns an outstanding claim unknown', () => {
  const { broker, s, time } = fixture(); const id = asked(broker, s);
  expect(broker.snooze(id, 1)).toBe(true); expect(broker.claim('client', 1)).toBeNull();
  time.advance(600_000); const claim = broker.claim('client', 1)!; expect(claim.notice.stage).toBe('reminder');
  time.advance(30_000); expect(broker.history().at(-1)!.state).toBe('unknown');
  expect(broker.claim('new-client', 1)).toBeNull();
  expect(broker.receipt(receipt(claim, 'requested'))).toBe(true); expect(broker.receipt(receipt(claim, 'clicked'))).toBe(true);
  expect(broker.snapshot().interactions).toHaveLength(1);
});
it('tracks parallel runtime-only requests by real UUID lifetime, with contextual anchors and independent identities', () => {
  const { broker, s, time, presentRole } = fixture(true);
  broker.consume(s, event('turn/start', 0, { turn: 1 }));
  const one = new AbortController(), two = new AbortController();
  const finish = broker.question(s, { source: 'runtime', nativeId: 'runtime-uuid-one', turn: 1, seq: 0, preview: 'Same question?', signal: one.signal });
  time.advance(1000);
  broker.question(s, { source: 'runtime', nativeId: 'runtime-uuid-two', turn: 1, seq: 0, preview: 'Same question?', signal: two.signal });
  const first = presentRole.mock.calls[0][0], second = presentRole.mock.calls[1][0];
  expect(first.id).not.toBe(second.id); expect(JSON.parse(first.id)).toEqual([s.id, 1, 0, 'question', 'initial', 'runtime-uuid-one']);
  expect(broker.snapshot().interactions).toMatchObject([{ source: 'runtime', nativeId: 'runtime-uuid-one' }, { source: 'runtime', nativeId: 'runtime-uuid-two' }]);
  time.advance(599_000); expect(JSON.parse(presentRole.mock.calls.at(-1)![0].id).at(-1)).toBe('runtime-uuid-one');
  time.advance(1000); expect(JSON.parse(presentRole.mock.calls.at(-1)![0].id).at(-1)).toBe('runtime-uuid-two');
  const id = interactionId(s.id, 'question', 'runtime-uuid-one');
  expect(broker.snooze(id, 1)).toBe(true); time.advance(600_000);
  expect(JSON.parse(presentRole.mock.calls.at(-1)![0].id).slice(-2)).toEqual(['runtime-uuid-one', 1]);
  finish(); expect(broker.snapshot().interactions).toHaveLength(1);
  two.abort(); expect(broker.snapshot().interactions).toHaveLength(0);
});
it('hands exact event-backed runtime requests to the public continued projection without premature settlement', () => {
  const { broker, s } = fixture();
  broker.consume(s, event('turn/start', 0, { turn: 1 }));
  broker.consume(s, event('tool/call', 1, { turn: 1, step: 1, callId: ToolCallId('timed-complete-id'), name: 'ask_user_question', arguments: '{}' }));
  const finish = broker.question(s, { nativeId: 'timed-complete-id', turn: 1, seq: 1, preview: 'Continue?' });
  broker.questions(s, { active: [{ callId: 'timed-complete-id', state: 'continued', questions: [{ question: 'Continue?' }] }] });
  finish(); expect(broker.snapshot().interactions).toMatchObject([{ nativeId: 'timed-complete-id', state: 'continued' }]);
  broker.consume(s, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }));
  expect(broker.snapshot().interactions).toHaveLength(1);
  broker.questions(s, { active: [], settled: [{ callId: 'timed-complete-id' }] });
  expect(broker.snapshot().interactions).toHaveLength(0);
});

it('stopping immediately revokes a visible generation without fabricating a new native visibility revision', () => {
  const { broker, s, time, presentRole } = fixture(true); asked(broker, s);
  expect(broker.runtime(runtime({ phase: 'stopping', visible: false }))).toBe(true);
  expect(time.timers.size).toBe(0); time.advance(600_000);
  expect(presentRole).toHaveBeenCalledOnce(); expect(broker.snooze(interactionId(s.id, 'approval', 'native-full'), 1)).toBe(false);
});
