import { it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval';
import { Config, mountPet } from '../src/index.ts';
import type { NativeLifecycle, PetBridge } from '../src/bridge.ts';

function setup() {
  const ctx = new Context(); new SessionProjectionRegistry(ctx); new SessionStore(ctx); new UserQuestionService(ctx);
  const session = ctx.sessions.create(SessionId('source-full-identity'));
  const agent = { id: session.id, session, ctx, status: 'idle' } as Agent;
  ctx.provide('agents', { list: () => [agent], get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent] });
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch(request: Request): Promise<Response> }) => { routes.set(route.path, route); return () => routes.delete(route.path); } } } as never);
  let lifecycle: ((state: NativeLifecycle) => void) | undefined, generation = 0, revision = 0;
  const role = vi.fn(() => true);
  const bridge: PetBridge = {
    start: async (_options, life) => { generation = life!.generation; revision = 0; lifecycle?.({ running: true, visible: life!.visible !== false, generation, visibilityRevision: ++revision }); },
    control: command => lifecycle?.({ running: true, visible: command !== 'hide', generation, visibilityRevision: ++revision }),
    onLifecycle: fn => { lifecycle = fn; }, removeLifecycle: () => { lifecycle = undefined; },
    onAction: vi.fn(), removeAction: vi.fn(), update: vi.fn(), notify: vi.fn(), notificationState: vi.fn(), presentRole: role, dispose: vi.fn(async () => {}),
  };
  const invoke = async (endpoint: string, payload: unknown = {}) => {
    const response = await routes.get(`/api/coopanion/${endpoint}`)!.fetch(new Request(`http://localhost/api/coopanion/${endpoint}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'integration', method: `coopanion/${endpoint}`, payload }) }));
    return (await response.json()).result;
  };
  return { ctx, session, agent, bridge, role, routes, invoke, lifecycle: (state: NativeLifecycle) => lifecycle?.(state) };
}

it('recovers Host state without replay and requires fresh native receipts for post-recovery claims', async () => {
  const { ctx, session, bridge, role, invoke, lifecycle } = setup();
  const scope = ctx.plugin(child => mountPet(child, Config({ autoStart: false, systemNotifications: true, reminders: false }), bridge));
  await scope.await(); vi.useFakeTimers();
  try {
    await ctx.coopanion.command('start'); await ctx.coopanion.command('hide');
    session.append('turn/start', { turn: 1 });
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { role: 'assistant', id: 'full-recovery-message', content: [{ type: 'text', text: '完整恢复结果\n' + '🐳'.repeat(2000) }] } } as never, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const initial = (await invoke('notification-claim', { clientId: 'before-crash', generation: 1 })).value;
    session.append('approval/asked', { id: ApprovalRequestId('pending-across-crash'), toolName: 'bash' });
    const before = vi.mocked(bridge.update).mock.calls.at(-1)![0];
    expect(before.results).toHaveLength(1);
    const pending = (await invoke('notification-state')).value.interactions;
    lifecycle({ running: false, visible: false, generation: 1, visibilityRevision: 100, unexpected: true });
    await vi.advanceTimersByTimeAsync(0); expect(ctx.coopanion.status().phase).toBe('recovering');
    expect((await invoke('notification-claim', { clientId: 'during-crash', generation: 1 })).value).toBeNull();
    // Readiness without a visibility receipt grants no channel, even when hidden was desired.
    bridge.start = vi.fn(async () => {}); bridge.control = vi.fn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.coopanion.status()).toMatchObject({ phase: 'running', generation: 2, visibilityRevision: 0, desiredVisible: false });
    expect((await invoke('notification-claim', { clientId: 'after-crash', generation: 2 })).value).toBeNull();
    lifecycle({ running: true, visible: false, generation: 1, visibilityRevision: 999 });
    expect(ctx.coopanion.status().visibilityRevision).toBe(0);
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 1, suspended: true });
    expect((await invoke('notification-claim', { clientId: 'after-crash', generation: 2 })).value).toBeNull();
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 2, suspended: false });
    const after = vi.mocked(bridge.update).mock.calls.at(-1)![0];
    expect(after.sessionId).toBe(before.sessionId); expect(after.results).toEqual(before.results);
    expect(after.sessions[0]!.unread).toBe(before.sessions[0]!.unread);
    expect((await invoke('notification-state')).value.interactions).toEqual(pending);
    expect((await invoke('notification-claim', { clientId: 'after-crash', generation: 2 })).value).toBeNull();
    const base = { token: initial.token, clientId: initial.clientId, noticeId: initial.notice.id, generation: initial.generation, time: Date.now() };
    expect((await invoke('notification-receipt', { ...base, state: 'requested' })).value.accepted).toBe(true);
    expect((await invoke('notification-receipt', { ...base, state: 'shown' })).value.accepted).toBe(true);
    session.append('approval/asked', { id: ApprovalRequestId('new-after-resume'), toolName: 'bash' });
    const fresh = (await invoke('notification-claim', { clientId: 'after-crash', generation: 2 })).value;
    expect(fresh).toMatchObject({ generation: 2, visibilityRevision: 2 });
    expect(fresh.notice.id).not.toBe(initial.notice.id);
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 3, suspended: true });
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 4, suspended: false });
    expect((await invoke('notification-claim', { clientId: 'another-client', generation: 2 })).value).toBeNull();
    expect(role).not.toHaveBeenCalled();
    session.append('approval/decided', { id: ApprovalRequestId('pending-across-crash'), outcome: 'allowed-once' });
    expect((await invoke('notification-state')).value.interactions).toHaveLength(1);
  } finally { await scope.dispose(); await ctx.fiber.dispose(); vi.useRealTimers(); }
});

it('mounts Harness without waiting for native startup and cancels startup on unload', async () => {
  const { ctx, bridge } = setup(); let aborted = false;
  bridge.start = vi.fn((_options, life) => new Promise<void>((_resolve, reject) => {
    life!.signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
  }));
  const scope = ctx.plugin(child => mountPet(child, Config(), bridge));
  try {
    await scope.await();
    await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('starting'));
    const controls = ctx.coopanion;
    await scope.dispose(); expect(aborted).toBe(true);
    expect(controls.status().phase).toBe('stopped');
  } finally { await ctx.fiber.dispose(); }
});

it('uses native visibility and exact audit identity for claims, accepts late evidence without another channel', async () => {
  const { ctx, session, bridge, role, invoke, routes } = setup();
  const scope = ctx.plugin(child => mountPet(child, Config({ systemNotifications: true }), bridge));
  try {
    await scope.await(); await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('running'));
    await ctx.coopanion.command('hide');
    session.append('turn/start', { turn: 1 });
    const native = ApprovalRequestId('approval-native-full');
    session.append('approval/asked', { id: native, toolName: 'bash' });
    const before = await invoke('notification-state'); expect(before.value.interactions).toHaveLength(1);
    const first = await invoke('notification-claim', { clientId: 'client-full', generation: before.value.runtime.generation });
    expect(first.value.notice.sessionId).toBe(session.id); expect(role).not.toHaveBeenCalled();
    await ctx.coopanion.command('show');
    expect(role).not.toHaveBeenCalled();
    expect((await invoke('notification-claim', { clientId: 'other', generation: before.value.runtime.generation })).value).toBeNull();
    const base = { token: first.value.token, clientId: 'client-full', generation: before.value.runtime.generation, noticeId: first.value.notice.id, time: Date.now() };
    expect((await invoke('notification-receipt', { ...base, token: 'wrong', state: 'requested' })).value.accepted).toBe(false);
    expect((await invoke('notification-receipt', { ...base, state: 'requested' })).value.accepted).toBe(true);
    expect((await invoke('notification-receipt', { ...base, state: 'shown' })).value.accepted).toBe(true);
    // Viewing/clicking preserves pending approval; only the audit decision settles it.
    expect((await invoke('notification-receipt', { ...base, state: 'clicked' })).value.accepted).toBe(true);
    expect((await invoke('notification-state')).value.interactions).toHaveLength(1);
    session.append('approval/decided', { id: native, outcome: 'allowed-once' });
    expect((await invoke('notification-state')).value.interactions).toHaveLength(0);
    await scope.dispose(); expect(routes.size).toBe(0);
  } finally { await ctx.fiber.dispose(); }
});

it('delegates public blocking questions and settles only after the original answerer finishes', async () => {
  const { ctx, agent, session, bridge, invoke, role } = setup();
  const scope = ctx.plugin(child => mountPet(child, Config(), bridge));
  try {
    await scope.await(); await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('running'));
    session.append('turn/start', { turn: 1 });
    let answer!: (value: { answers: [] }) => void;
    const delegate = vi.fn(() => new Promise<{ answers: [] }>(resolve => { answer = resolve; }));
    const request = ctx.waterfall('user-questions/request', { agent, questions: [{ id: 'full-question', question: 'Choose an option' }] }, delegate as never);
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    const pending = (await invoke('notification-state')).value.interactions;
    expect(pending).toHaveLength(1); expect(pending[0].source).toBe('runtime'); expect(pending[0].preview).toBe('Choose an option');
    expect(role).toHaveBeenCalledWith(expect.objectContaining({ source: 'runtime', category: 'question' }), expect.anything());
    expect((await invoke('notification-snooze', { interactionId: pending[0].id, generation: ctx.coopanion.status().generation })).ok).toBe(true);
    expect((await invoke('notification-state')).value.interactions).toHaveLength(1);
    answer({ answers: [] }); await request;
    expect((await invoke('notification-state')).value.interactions).toHaveLength(0);
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});

it('observes a public question when the Harness answerer was registered before the plugin', async () => {
  const { ctx, agent, session, bridge, invoke } = setup();
  let answer!: (value: { answers: [] }) => void;
  const original = vi.fn(() => new Promise<{ answers: [] }>(resolve => { answer = resolve; }));
  ctx.on('user-questions/request', original);
  const scope = ctx.plugin(child => mountPet(child, Config(), bridge));
  try {
    await scope.await(); await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('running'));
    session.append('turn/start', { turn: 1 });
    const request = ctx.userQuestions.ask({ agent, questions: [{ id: 'q', question: 'Answer through Harness' }] });
    await vi.waitFor(() => expect(original).toHaveBeenCalledOnce());
    expect((await invoke('notification-state')).value.interactions).toHaveLength(1);
    answer({ answers: [] }); await expect(request).resolves.toEqual({ answers: [] });
    expect((await invoke('notification-state')).value.interactions).toHaveLength(0);
    expect(original).toHaveBeenCalledOnce();
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});

it('tracks the public timed projection through continued and exact late reply settlement', async () => {
  const { ctx, session, bridge, invoke } = setup();
  const scope = ctx.plugin(child => mountPet(child, Config(), bridge));
  try {
    await scope.await(); await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('running'));
    const callId = 'integration-timed-question-full';
    session.append('turn/start', { turn: 1 });
    session.append('request/header', { reason: 'initial', header: { tools: [{ name: 'ask_user_question', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }] } } as never);
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Continue later?' }] }) } as never);
    const origin = session.snapshotEvents().at(-1)!;
    expect((await invoke('notification-state')).value.interactions).toMatchObject([{ nativeId: callId, state: 'open', turn: 1, seq: origin.seq }]);
    session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: 'pending-result', toolCallId: callId, content: [{ type: 'text', text: '{"pending":true}' }] } } as never, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect((await invoke('notification-state')).value.interactions).toMatchObject([{ nativeId: callId, state: 'continued', turn: 1, seq: origin.seq }]);
    session.append('turn/start', { turn: 2 });
    const reply = (identity: string) => session.append('user/message', { role: 'user', id: `reply-${identity}`, content: [{ type: 'text', text: '{"answers":[]}' }], source: { kind: 'user-question-reply', callId: identity, outcome: 'answered' } } as never, { surfaceOp: 'append' });
    reply('integration-timed-question');
    expect((await invoke('notification-state')).value.interactions).toHaveLength(1);
    reply(callId);
    expect((await invoke('notification-state')).value.interactions).toHaveLength(0);
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});

it('keeps the original question answerer usable when reminder tracking reaches capacity', async () => {
  const { ctx, agent, session, bridge, invoke } = setup();
  const scope = ctx.plugin(child => mountPet(child, Config({ autoStart: false }), bridge));
  try {
    await scope.await(); session.append('turn/start', { turn: 1 });
    for (let n = 0; n < 500; n++) session.append('approval/asked', { id: ApprovalRequestId(`capacity-${n}`), toolName: 'bash' });
    const answer = { answers: [] }, delegate = vi.fn(async () => answer);
    await expect(ctx.waterfall('user-questions/request', { agent, questions: [{ id: 'q', question: 'Still answerable?' }] }, delegate as never)).resolves.toEqual(answer);
    expect(delegate).toHaveBeenCalledOnce();
    expect((await invoke('notification-state')).value.interactions).toHaveLength(500);
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});

it('restores dormant continued questions when optional projection services become available after mounting', async () => {
  const ctx = new Context(); new SessionStore(ctx);
  const session = ctx.sessions.create(SessionId('dormant-full-session'));
  const callId = 'dormant-full-call';
  session.append('turn/start', { turn: 1 });
  session.append('request/header', { reason: 'initial', header: { tools: [{ name: 'ask_user_question', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }] } } as never);
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Still waiting?' }] }) } as never);
  session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: 'dormant-pending', toolCallId: callId, content: [{ type: 'text', text: '{"pending":true}' }] } } as never, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  ctx.provide('agents', { list: () => [] });
  const bridge: PetBridge = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}), onAction: vi.fn(), removeAction: vi.fn(), update: vi.fn(), notify: vi.fn(), notificationState: vi.fn() };
  const scope = ctx.plugin(child => mountPet(child, Config({ autoStart: false }), bridge));
  try {
    await scope.await();
    expect(bridge.notificationState).toHaveBeenLastCalledWith(expect.objectContaining({ interactions: [] }));
    new SessionProjectionRegistry(ctx); new UserQuestionService(ctx);
    await vi.waitFor(() => expect(bridge.notificationState).toHaveBeenLastCalledWith(expect.objectContaining({ interactions: [expect.objectContaining({ sessionId: session.id, nativeId: callId, state: 'continued' })] })));
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});
