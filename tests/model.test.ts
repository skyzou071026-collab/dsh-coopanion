import { describe, it, expect } from 'vitest';
import { PetModel } from '../src/model.ts';
import { SessionId, SessionSeq, type SessionEvent, type Session } from '@deepseek-ai/dsh-session';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types';
import { GoalId } from '@deepseek-ai/dsh-goal';
import { interactionId, type PendingInteraction } from '../src/notification-contract.ts';
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId, LlmAttemptId } from '@deepseek-ai/dsh-llm';

function session(id: string, origin?: 'subagent'): Pick<Session, 'id' | 'header'> {
  return { id: SessionId(id), header: { version: 4, id: SessionId(id), createdAt: 0, isSeeded: false, cwd: `/project/${id}`, origin } };
}
let seq = 0;
function event<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  return { type, data, seq: SessionSeq(seq++), time: 0 } as SessionEvent;
}

function commitGoal(m: PetModel, s: Pick<Session, 'id' | 'header'>) {
  for (const [operation, phase, revision] of [['create', 'active', 1], ['complete', 'complete', 2]] as const) {
    m.consume(s, event('goal/change', { kind: 'goal/change', version: 1, operation, goal: { id: GoalId('goal-complete'), revision, phase, objective: 'Finish', maxGoalRounds: 8 }, roundsStarted: 0, createdAt: 0, updatedAt: revision }));
  }
}

describe('Harness task presentation', () => {
  it('restores distinct human prompts for sessions in the same project without replaying task states', () => {
    const m = new PetModel(), first = session('session-aaa111'), second = session('session-bbb222');
    const a = { ...first, header: { ...first.header, cwd: '/project/shared' } }, b = { ...second, header: { ...second.header, cwd: '/project/shared' } };
    const prompt = event('user/message', createUserMessage({ content: [{ type: 'text', text: '修复\n状态栏同步' }], source: { kind: 'user' } }));
    m.observe({ ...a, snapshotEvents: () => [prompt] }); m.observe(b);
    m.consume(b, event('user/message', createUserMessage({ content: [{ type: 'text', text: '重做会话选择' }], source: { kind: 'user' } })));
    expect(m.snapshot().sessions.map(s => [s.label, s.project, s.cwd])).toEqual([['修复 状态栏同步', 'shared', '/project/shared'], ['重做会话选择', 'shared', '/project/shared']]);
    expect(m.snapshot().mood).toBe('idle');
  });
  it('tracks real reasoning and text streams without restarting or accepting stale attempts', () => {
    const m = new PetModel(), s = session('stream'), attemptId = LlmAttemptId('first');
    m.consume(s, event('turn/start', { turn: 1 }));
    m.stream(s, { type: 'start', attemptId, revision: 1, turn: 1, step: 1 });
    m.stream(s, { type: 'chunk', attemptId, revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } });
    expect(m.snapshot()).toMatchObject({ mood: 'thinking', active: true, streaming: true });
    expect(m.snapshot().text).not.toContain('private');
    for (const [index, text] of ['你好', '，正在输出'].entries()) m.stream(s, { type: 'chunk', attemptId, revision: 1, index: index + 1, time: 2, chunk: { type: 'text-delta', index: 1, text } });
    expect(m.snapshot()).toMatchObject({ mood: 'talking', speechId: attemptId, results: [] });
    expect(m.snapshot().sessions[0].reply).toBe('');
    expect(m.stream(s, { type: 'chunk', attemptId, revision: 1, index: 1, time: 1, chunk: { type: 'text-delta', index: 1, text: '重复' } })).toBe(false);
    m.stream(s, { type: 'chunk', attemptId, revision: 1, index: 3, time: 3, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '你好，正在输出' } } });
    m.stream(s, { type: 'chunk', attemptId, revision: 1, index: 4, time: 4, chunk: { type: 'text-delta', index: 2, text: '第二段' } });
    expect(m.snapshot().results).toEqual([]);
    m.consume(s, event('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '你好，正在输出' }, { type: 'text', text: '第二段' }], source: { provider: 'test', model: 'test' } }), stream: [] }));
    expect(m.snapshot()).toMatchObject({ mood: 'talking', streaming: false, speechId: attemptId });
    m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    expect(m.snapshot()).toMatchObject({ mood: 'idle', active: false });
    expect(m.snapshot().results[0].text).toBe('你好，正在输出\n第二段');
    expect(m.stream(s, { type: 'start', attemptId, revision: 1, turn: 1, step: 1 })).toBe(false);
    expect(m.stream(s, { type: 'chunk', attemptId, revision: 1, index: 3, time: 3, chunk: { type: 'text-delta', index: 1, text: '迟到' } })).toBe(false);
    m.consume(s, event('turn/start', { turn: 2 }));
    expect(m.stream(s, { type: 'start', attemptId, revision: 1, turn: 1, step: 1 })).toBe(false);
  });
  it('shows task work and assistant replies, then issues a completion notification', () => {
    const m = new PetModel(), s = session('one');
    m.consume(s, event('turn/start', { turn: 1 })); expect(m.snapshot().mood).toBe('thinking');
    m.consume(s, event('tool/call', { turn: 1, step: 1, name: 'read_file', callId: ToolCallId('t1'), arguments: '{}' }));
    expect(m.snapshot().text).toBe('正在看文件');
    const message = createAssistantMessage({ content: [{ type: 'text', text: '做好了！' }], source: { provider: 'test', model: 'test' } });
    m.consume(s, event('assistant/message', { turn: 1, step: 1, message, stream: [] }));
    expect(m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))?.body).toBe('做好了！');
    expect(m.snapshot().mood).toBe('idle');
  });
  it('keeps background sessions and subagents from changing the selected task', () => {
    const m = new PetModel(), a = session('one'), b = session('two');
    m.consume(a, event('turn/start', { turn: 1 }));
    const n = m.consume(b, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    expect(n?.sessionId).toBe('two'); expect(m.snapshot().sessionId).toBe('one'); expect(m.snapshot().mood).toBe('thinking');
    m.consume(session('child', 'subagent'), event('turn/start', { turn: 1 }));
    expect(m.snapshot().sessions).toHaveLength(2); expect(m.select('missing')).toBe(false);
    m.select('two'); expect(m.snapshot().mood).toBe('idle');
    m.remove('two'); expect(m.snapshot().sessionId).toBe('one');
  });
  it('keeps explicit focus when new sessions start, and selects the first available session', () => {
    const m = new PetModel(), old = session('old'), fresh = session('fresh');
    m.observe(old);
    expect(m.created(fresh)).toBe(true);
    expect(m.snapshot()).toMatchObject({ sessionId: 'old', mood: 'idle' });
    m.consume(fresh, event('turn/start', { turn: 1 }));
    expect(m.snapshot()).toMatchObject({ sessionId: 'old', mood: 'idle' });
    expect(m.snapshot().sessions.find(s => s.id === 'fresh')?.mood).toBe('thinking');
    expect(m.created(session('child', 'subagent'))).toBe(false);
    expect(m.snapshot().sessionId).toBe('old');
    m.select('fresh'); expect(m.snapshot().mood).toBe('thinking');
    const empty = new PetModel(); empty.created(fresh); expect(empty.snapshot().sessionId).toBe('fresh');
  });
  it('retains complete confirmed results and acknowledges each completion independently', () => {
    const m = new PetModel(), a = session('focus'), b = session('background');
    m.observe(a); m.created(b);
    const finish = (turn: number, text: string) => {
      m.consume(b, event('turn/start', { turn }));
      m.consume(b, event('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }), stream: [] }));
      expect(m.snapshot().results).toHaveLength(turn - 1);
      m.consume(b, event('turn/end', { turn, reason: { kind: 'completed' } }));
    };
    const long = '长回复🐳\n'.repeat(800) + '完整结尾';
    finish(1, long); finish(2, '第二份');
    expect(m.snapshot().sessionId).toBe('focus');
    expect(m.snapshot().results.map(r => r.text)).toEqual([long, '第二份']);
    expect(m.snapshot().sessions.find(s => s.id === 'background')?.unread).toBe(2);
    const id = m.snapshot().results[0].id;
    expect(m.read(id)).toBe(true); expect(m.read(id)).toBe(false); expect(m.read('missing')).toBe(false);
    expect(m.snapshot().sessions.find(s => s.id === 'background')?.unread).toBe(1);
    m.select('background'); expect(m.snapshot().results[1].read).toBe(false);
    m.consume(b, event('turn/start', { turn: 3 }));
    m.consume(b, event('assistant/message', { turn: 3, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '未完成的内容' }], source: { provider: 'test', model: 'test' } }), stream: [] }));
    m.consume(b, event('turn/end', { turn: 3, reason: { kind: 'interrupted' } }));
    expect(m.snapshot().results).toHaveLength(2);
    expect(m.snapshot().sessions.find(s => s.id === 'background')?.reply).toBe('第二份');
  });
  it('distinguishes canceled, blocked and failed turns from successful completion', () => {
    const m = new PetModel(), s = session('one');
    m.consume(s, event('turn/start', { turn: 1 }));
    expect(m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }))?.category).toBe('interrupted');
    expect(m.snapshot().mood).toBe('waiting');
    expect(m.consume(s, event('turn/end', { turn: 2, reason: { kind: 'blocked' } }))?.title).toContain('暂停');
    expect(m.consume(s, event('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'test' } } }))?.title).toContain('需要关注');
    expect(m.snapshot().mood).toBe('error');
  });
  it('does not erase a settled task when an approval finishes late', () => {
    const m = new PetModel(), s = session('one'); m.observe(s);
    expect(m.approval('one', 'bash')?.title).toContain('确认');
    m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    m.approvalSettled('one'); expect(m.snapshot().mood).toBe('idle');
  });
  it('returns to idle after completion without extending its deadline on selection or background activity', () => {
    let now = 1000;
    const m = new PetModel(() => now), a = session('one'), b = session('two');
    m.consume(a, event('turn/start', { turn: 1 }));
    commitGoal(m, a);
    const completed = event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(m.consume(a, completed)?.sessionId).toBe('one');
    expect(m.snapshot().mood).toBe('happy');
    const revision = m.snapshot().revision;
    expect(m.consume(a, completed)).toBeUndefined();
    now += 1500; m.consume(b, event('turn/start', { turn: 1 }));
    m.select('two'); m.select('one'); expect(m.snapshot().revision).toBe(revision);
    now += 1000; expect(m.settle()).toBe(true); expect(m.snapshot().mood).toBe('idle');
    expect(m.snapshot().text).not.toContain('完成');
    expect(m.settle()).toBe(false);
  });
  it('starts with the current running task and cancels a previous celebration when a new turn begins', () => {
    let now = 1000; const m = new PetModel(() => now), s = session('one');
    m.running(s); expect(m.snapshot().mood).toBe('thinking');
    m.consume(s, event('turn/start', { turn: 1 })); commitGoal(m, s);
    m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    m.consume(s, event('turn/start', { turn: 2 }));
    now += 10000; expect(m.settle()).toBe(false); expect(m.snapshot().mood).toBe('thinking');
  });
  it('keeps working until all parallel tools finish and waiting until all approvals finish', () => {
    const m = new PetModel(), s = session('one');
    m.consume(s, event('turn/start', { turn: 1 }));
    for (const id of ['a', 'b']) m.consume(s, event('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name: 'bash', arguments: '{}' }));
    const first = Symbol(), second = Symbol(); m.approval('one', 'bash', first); m.approval('one', 'bash', second);
    m.approvalSettled('one', first); expect(m.snapshot().mood).toBe('waiting');
    m.approvalSettled('one', second); expect(m.snapshot().mood).toBe('working');
    for (const id of ['a', 'b']) {
      m.consume(s, event('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(id), content: [], isError: false }) }));
      expect(m.snapshot().mood).toBe(id === 'a' ? 'working' : 'thinking');
    }
  });
  it('keeps a failed tool step in active processing until the turn actually fails', () => {
    const m = new PetModel(), s = session('tool-error');
    m.consume(s, event('turn/start', { turn: 1 }));
    m.consume(s, event('tool/call', { turn: 1, step: 1, callId: ToolCallId('failed-step'), name: 'bash', arguments: '{}' }));
    m.consume(s, event('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('failed-step'), content: [], isError: true }) }));
    expect(m.snapshot()).toMatchObject({ mood: 'thinking', active: true, results: [] });
    m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Turn failed' } } }));
    expect(m.snapshot()).toMatchObject({ mood: 'error', active: false });
  });
  it('ignores stale turn events and approval settlements from a previous turn', () => {
    const m = new PetModel(), s = session('one'), old = Symbol(), current = Symbol();
    m.consume(s, event('turn/start', { turn: 1 })); m.approval('one', 'bash', old);
    m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    m.consume(s, event('turn/start', { turn: 2 })); m.approval('one', 'bash', current);
    m.approvalSettled('one', old); expect(m.snapshot().mood).toBe('waiting');
    expect(m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBeUndefined();
    expect(m.snapshot().mood).toBe('waiting');
    m.approvalSettled('one', current); expect(m.snapshot().mood).toBe('thinking');
  });
});

it('pairs actual approval audit ids and keeps continued questions waiting after completed turns and viewed results', () => {
  const m = new PetModel(), s = session('pending');
  m.consume(s, event('turn/start', { turn: 1 }));
  m.consume(s, event('approval/asked', { id: ApprovalRequestId('approval-full'), toolName: 'bash' }));
  m.consume(s, event('approval/decided', { id: ApprovalRequestId('approval'), outcome: 'allowed-once' }));
  expect(m.snapshot().mood).toBe('waiting');
  m.consume(s, event('approval/decided', { id: ApprovalRequestId('approval-full'), outcome: 'allowed-once' }));
  expect(m.snapshot().mood).toBe('thinking');
  const request: PendingInteraction = { id: interactionId(s.id, 'question', 'full-call-id'), sessionId: s.id, nativeId: 'full-call-id', kind: 'question', turn: 1, seq: 5, createdAt: 1000, preview: 'Question?', state: 'continued', dueAt: null, automaticReminders: 0 };
  m.consume(s, event('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Result' }], source: { provider: 'test', model: 'test' } }), stream: [] }));
  m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  m.interactions([request]); expect(m.snapshot()).toMatchObject({ mood: 'waiting', active: false });
  m.select(s.id); m.read(m.snapshot().results[0].id);
  expect(m.snapshot().mood).toBe('waiting');
  m.interactions([{ ...request, state: 'settled' }]); expect(m.snapshot().mood).toBe('idle');
});

it('preserves interrupted and blocked expressions when no pending request entrance exists', () => {
  const m = new PetModel(), s = session('terminal');
  m.consume(s, event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }));
  m.interactions([]); expect(m.snapshot()).toMatchObject({ mood: 'waiting', text: '这段任务中断了，陪你回去看看。' });
  m.consume(s, event('turn/end', { turn: 2, reason: { kind: 'blocked' } }));
  m.interactions([]); expect(m.snapshot().text).toContain('暂时停下');
});
it('restores confirmed historical results as read without celebration or duplicate event processing', () => {
  let now = 1000; const m = new PetModel(() => now), s = session('history');
  const begin = event('turn/start', { turn: 1 });
  const reply = event('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Complete historical result' }], source: { provider: 'test', model: 'test' } }), stream: [] });
  const end = event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const restored = { ...s, snapshotEvents: () => [begin, reply, end] };
  m.observe(restored); expect(m.snapshot().results).toEqual([]); // observe keeps its original identity-only behavior.
  expect(m.restore(restored)).toBeUndefined();
  expect(m.snapshot()).toMatchObject({ mood: 'idle', active: false, results: [{ text: 'Complete historical result', read: true }] });
  expect(m.snapshot().sessions[0]).toMatchObject({ reply: 'Complete historical result', unread: 0 });
  expect(m.consume(s, end)).toBeUndefined();
  now += 3000; expect(m.settle()).toBe(false);
  const id = m.snapshot().results[0].id; m.read(id); m.restore(restored);
  expect(m.snapshot().results).toHaveLength(1); expect(m.snapshot().results[0].read).toBe(true); expect(m.snapshot().sessions[0].unread).toBe(0);
  const freshHost = new PetModel(); freshHost.restore(restored); expect(freshHost.snapshot().results[0].read).toBe(true);
});
it('restores actual historical terminal outcomes without notices or invented interruptions', () => {
  const reasons = [
    { reason: { kind: 'aborted', reason: { kind: 'user' } }, mood: 'idle', text: '先停在这里' },
    { reason: { kind: 'interrupted' }, mood: 'waiting', text: '中断' },
    { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'failed' } }, mood: 'error', text: '遇到了问题' },
    { reason: { kind: 'blocked' }, mood: 'waiting', text: '暂时停下' },
    { reason: { kind: 'max-tokens' }, mood: 'waiting', text: '暂时停下' },
    { reason: { kind: 'forked' }, mood: 'idle', text: '准备好了' },
  ] as const;
  for (const { reason, mood, text } of reasons) {
    const m = new PetModel(), s = session(`history-${reason.kind}`), begin = event('turn/start', { turn: 1 }), end = event('turn/end', { turn: 1, reason });
    expect(m.restore({ ...s, snapshotEvents: () => [begin, end] })).toBeUndefined();
    expect(m.snapshot()).toMatchObject({ mood, active: false, results: [] }); expect(m.snapshot().text).toContain(text);
    expect(m.consume(s, end)).toBeUndefined(); expect(m.settle()).toBe(false);
  }
  const unfinished = new PetModel(), s = session('unfinished');
  unfinished.restore({ ...s, snapshotEvents: () => [event('turn/start', { turn: 1 }), event('tool/call', { turn: 1, step: 1, callId: ToolCallId('unfinished-call'), name: 'bash', arguments: '{}' })] });
  expect(unfinished.snapshot()).toMatchObject({ mood: 'working', active: true, results: [] });
  expect(unfinished.snapshot().text).not.toContain('中断');
});
it('restores exact native approval pairs and keeps public continued entrances when an agent resumes running', () => {
  const m = new PetModel(), s = session('restored-pending');
  const begin = event('turn/start', { turn: 1 }), ask = event('approval/asked', { id: ApprovalRequestId('native-complete-id'), toolName: 'bash' });
  const wrong = event('approval/decided', { id: ApprovalRequestId('native'), outcome: 'allowed-once' });
  m.restore({ ...s, snapshotEvents: () => [begin, ask, wrong] }); expect(m.snapshot().mood).toBe('waiting');
  const end = event('turn/end', { turn: 1, reason: { kind: 'completed' } }); m.restore({ ...s, snapshotEvents: () => [begin, ask, wrong, end] });
  expect(m.snapshot()).toMatchObject({ mood: 'idle', active: false });
  const pending: PendingInteraction = { id: interactionId(s.id, 'question', 'late-full-call'), sessionId: s.id, nativeId: 'late-full-call', kind: 'question', turn: 1, seq: 5, createdAt: 1000, preview: 'Still answerable', state: 'continued', dueAt: null, automaticReminders: 0 };
  m.interactions([pending]); m.running(s);
  expect(m.snapshot()).toMatchObject({ mood: 'waiting', active: true }); expect(m.snapshot().text).toContain('问题');
  m.restore({ ...s, snapshotEvents: () => [begin, ask, wrong, end] }); expect(m.snapshot()).toMatchObject({ mood: 'waiting', active: true });
  m.interactions([{ ...pending, state: 'settled' }]); expect(m.snapshot().mood).toBe('thinking');
});
