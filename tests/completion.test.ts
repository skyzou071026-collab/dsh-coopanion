import { expect, it } from 'vitest';
import { PetModel } from '../src/model.ts';
import { NotificationBroker } from '../src/notification-broker.ts';
import { SessionId, SessionSeq, type SessionEvent, type Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-goal';
const session = { id: SessionId('goal-session-full'), header: { version: 4, id: SessionId('goal-session-full'), createdAt: 0, isSeeded: false } } satisfies Pick<Session, 'id' | 'header'>;
function change(phase = 'active', operation = 'create', revision = 1, id = 'goal-full-identity', roundsStarted = 0) {
  return { kind: 'goal/change', version: 1, operation, goal: { id, revision, objective: 'M1 objective', phase, maxGoalRounds: 8, ...(phase === 'blocked' ? { blockedReason: { code: 'external-blocker', message: 'Waiting for input' } } : {}) }, roundsStarted, createdAt: 0, updatedAt: revision };
}
function replay() {
  const model = new PetModel(), broker = new NotificationBroker(); let seq = 0;
  broker.runtime({ phase: 'running', generation: 1, visibilityRevision: 1, visible: false, suspended: false });
  const events: SessionEvent[] = [];
  const feed = (type: string, data: unknown) => {
    const event = { type, data, seq: SessionSeq(seq++), time: 10 } as SessionEvent;
    events.push(event); broker.consume(session, event); model.consume(session, event); return event;
  };
  const reply = (turn: number) => feed('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: `Full reply ${turn}` }], source: { provider: 'controlled', model: 'test' } }) });
  return { model, broker, feed, reply, events };
}
it('retains the first human turn reply without celebrating an active goal', () => {
  const r = replay();
  r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.reply(1);
  r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  expect(r.model.snapshot().results[0].text).toBe('Full reply 1');
  expect(r.model.snapshot().sessions[0].unread).toBe(1);
  expect(r.model.snapshot().mood).not.toBe('happy');
  expect(r.broker.history().at(-1)?.notice.category).toBe('goal-progress');
});
it('uses exact admitted rounds, rejects tool intent as success, and celebrates the committed terminal once', () => {
  const r = replay();
  r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.reply(1); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  r.feed('turn/start', { turn: 2 });
  r.feed('user/message', { role: 'user', id: 'goal-round-full', content: [], source: { kind: 'goal', goalId: 'goal-full-identity', revision: 1, round: 1 } });
  r.feed('tool/call', { turn: 2, step: 1, name: 'update_goal', callId: 'failed-full', arguments: '{"action":"complete"}' });
  r.feed('tool/result', { turn: 2, step: 1, message: { role: 'tool', id: 'error', toolCallId: 'failed-full', isError: true, content: [] } });
  r.reply(2); r.feed('turn/end', { turn: 2, reason: { kind: 'completed' } });
  expect(r.model.snapshot().mood).toBe('idle');
  expect(r.broker.history().at(-1)?.notice).toMatchObject({ category: 'goal-progress', goal: { id: 'goal-full-identity', revision: 1, round: 1 } });
  r.feed('turn/start', { turn: 3 }); r.feed('goal/change', change('complete', 'complete', 2, 'goal-full-identity', 1)); r.reply(3);
  const end = r.feed('turn/end', { turn: 3, reason: { kind: 'completed' } });
  expect(r.model.snapshot()).toMatchObject({ mood: 'happy', sessions: [{ unread: 3, completion: 'completed' }] });
  expect(r.broker.history().at(-1)?.notice).toMatchObject({ category: 'completed', goal: { id: 'goal-full-identity', revision: 2, round: 1 } });
  r.model.consume(session, end); r.broker.consume(session, end);
  r.feed('turn/end', { turn: 3, reason: { kind: 'completed' } });
  expect(r.model.snapshot().results).toHaveLength(3); expect(r.broker.history()).toHaveLength(3);
  r.feed('turn/start', { turn: 4 }); r.reply(4); r.feed('turn/end', { turn: 4, reason: { kind: 'completed' } });
  expect(r.model.snapshot().mood).toBe('idle'); expect(r.broker.history().at(-1)?.notice.category).toBe('reply');
});
it.each(['blocked', 'paused'] as const)('presents committed %s without a success signal, including after turn/end', phase => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.reply(1);
  r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  r.feed('goal/change', change(phase, phase === 'blocked' ? 'block' : 'pause', 2));
  expect(r.model.snapshot().mood).toBe(phase === 'blocked' ? 'waiting' : 'idle');
  expect(r.broker.history().at(-1)?.notice.category).toBe(phase === 'blocked' ? 'blocked' : 'stopped');
  expect(r.model.snapshot().results).toHaveLength(1);
});
it.each(['error', 'aborted', 'interrupted', 'blocked', 'max-tokens'])('keeps the %s outcome authoritative even after a committed complete update', kind => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.feed('goal/change', change('complete', 'complete', 2));
  r.feed('turn/end', { turn: 1, reason: { kind } });
  expect(r.model.snapshot().mood).not.toBe('happy');
  expect(r.broker.history().at(-1)?.notice.category).toBe(kind === 'aborted' ? 'stopped' : kind);
});
it.each(['wrong-id', 'stale-revision', 'unknown-schema', 'missing-create'])('falls back immediately for %s and retains the complete reply', fault => {
  const r = replay(); r.feed('turn/start', { turn: 1 });
  if (fault !== 'missing-create') r.feed('goal/change', change());
  const data = change('complete', 'complete', fault === 'stale-revision' ? 1 : 2, fault === 'wrong-id' ? 'goal-full' : 'goal-full-identity');
  if (fault === 'unknown-schema') data.version = 99;
  r.feed('goal/change', data); r.reply(1); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  expect(r.model.snapshot()).toMatchObject({ mood: 'idle', text: '本轮回复已生成，回到会话查看。' });
  expect(r.model.snapshot().results[0].text).toBe('Full reply 1'); expect(r.broker.history().at(-1)?.notice.category).toBe('reply');
});
it('restores history as read, keeps old completions quiet, and isolates a new goal in the same session', () => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.feed('goal/change', change('complete', 'complete', 2)); r.reply(1); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const historical = { ...session, snapshotEvents: () => [...r.events] };
  const model = new PetModel(), broker = new NotificationBroker(); model.restore(historical); broker.restore(historical);
  expect(model.snapshot()).toMatchObject({ mood: 'idle', sessions: [{ unread: 0 }], results: [{ read: true }] }); expect(broker.history()).toEqual([]);
  const begin = r.feed('turn/start', { turn: 2 }), goal = r.feed('goal/change', change('active', 'create', 1, 'new-full-goal'));
  const answer = r.reply(2), end = r.feed('turn/end', { turn: 2, reason: { kind: 'completed' } });
  for (const event of [begin, goal, answer, end]) { model.consume(historical, event); broker.consume(historical, event); }
  expect(model.snapshot().mood).toBe('idle'); expect(model.snapshot().sessions[0].unread).toBe(1);
});
it('keeps parallel sessions independent and filters subagents from both consumers', () => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change());
  const other = { ...session, id: SessionId('other-full-session') }, child = { ...other, header: { ...other.header, origin: 'subagent' as const } };
  let seq = 20;
  for (const s of [other, child]) for (const [type, data] of [['turn/start', { turn: 1 }], ['goal/change', change()], ['goal/change', change('complete', 'complete', 2)], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]] as const) {
    const e = { type, data, seq: SessionSeq(seq++), time: 20 } as SessionEvent; r.model.consume(s, e); r.broker.consume(s, e);
  }
  expect(r.model.snapshot().sessionId).toBe(session.id); expect(r.model.snapshot().mood).toBe('thinking');
  expect(r.model.snapshot().sessions).toHaveLength(2); expect(r.broker.history()).toHaveLength(1); expect(r.broker.history()[0].notice.sessionId).toBe(other.id);
});
it('ignores a late older turn end before the new goal terminal update and preserves the real error outcome', () => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.reply(1); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  r.feed('turn/start', { turn: 2 }); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  r.feed('goal/change', change('complete', 'complete', 2));
  expect(r.model.snapshot().mood).not.toBe('happy'); expect(r.broker.history().some(h => h.notice.category === 'completed')).toBe(false);
  r.feed('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'controlled failure' } } });
  expect(r.model.snapshot().mood).toBe('error'); expect(r.broker.history().at(-1)?.notice.category).toBe('error');
});
it('clears a former goal blocker without replaying a notice, then treats a fresh goal independently', () => {
  const r = replay(); r.feed('turn/start', { turn: 1 }); r.feed('goal/change', change()); r.feed('turn/end', { turn: 1, reason: { kind: 'completed' } });
  r.feed('goal/change', change('blocked', 'block', 2));
  const count = r.broker.history().length;
  r.feed('goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-full-identity', revision: 3 }, clearedAt: 3 });
  expect(r.model.snapshot().mood).toBe('idle'); expect(r.model.snapshot().sessions[0].completion).toBeUndefined(); expect(r.broker.history()).toHaveLength(count);
  r.feed('goal/change', change('active', 'create', 1, 'fresh-goal-full'));
  expect(r.model.snapshot().mood).toBe('idle'); expect(r.model.snapshot().sessions[0].completion).toBe('goal-progress'); expect(r.broker.history()).toHaveLength(count);
});
