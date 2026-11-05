import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** Installed plugin + published services; native visibility and human answers are controlled boundaries. */
export async function verifyInstalledServices({ modules, plugin }) {
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { UserQuestionService }, { ApprovalService }, { mountPet, Config }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-session-projection'), load('dsh-user-questions'), load('dsh-user-approval'),
    import(pathToFileURL(join(plugin, 'dist/index.js')).href),
  ]);
  const ctx = new Context();
  new SessionProjectionRegistry(ctx); new SessionStore(ctx); new UserQuestionService(ctx); new ApprovalService(ctx, { policy: 'ask' });
  const session = ctx.sessions.create('installed-service-source');
  const agent = { id: session.id, session, ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    // Admission is controlled here; answer() creates the actual public reply message.
    steer: message => session.append('user/message', message, { surfaceOp: 'append' }),
  };
  ctx.provide('agents', { list: () => [agent], get: id => id === agent.id ? agent : undefined, roots: () => [agent] });
  const routes = new Map();
  ctx.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  let lifecycle, generation, revision = 0;
  const bridge = {
    start: async (_options, life) => { generation = life.generation; lifecycle({ running: true, visible: true, generation, visibilityRevision: ++revision }); },
    control: command => lifecycle({ running: true, visible: command !== 'hide', generation, visibilityRevision: ++revision }),
    onLifecycle: callback => { lifecycle = callback; }, removeLifecycle: () => { lifecycle = undefined; },
    onAction() {}, removeAction() {}, update() {}, notify() {}, notificationState() {}, presentRole: () => true, dispose: async () => {},
  };
  const call = async (endpoint, payload = {}) => {
    const response = await routes.get(`/api/coopanion/${endpoint}`).fetch(new Request(`http://localhost/api/coopanion/${endpoint}`, {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'installed-service', method: `coopanion/${endpoint}`, payload }),
    }));
    const envelope = await response.json(); assert.equal(envelope.result.ok, true, JSON.stringify(envelope)); return envelope.result.value;
  };
  const wait = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'published service did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  let approvalAnswer;
  ctx.on('approval/request', () => new Promise(resolve => { approvalAnswer = resolve; }));
  ctx.on('user-questions/request', request => new Promise((_resolve, reject) => {
    if (request.signal?.aborted) reject(request.signal.reason);
    else request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }));
  const scope = ctx.plugin(child => mountPet(child, Config({ systemNotifications: true }), bridge));
  const cases = {};
  try {
    await scope.await(); await wait(() => ctx.coopanion.status().phase === 'running');
    await ctx.coopanion.command('hide');
    session.append('turn/start', { turn: 1 });
    const approval = ctx.approval.request({ agent, toolName: 'bash', callId: 'installed-approval-full' });
    await wait(() => !!approvalAnswer);
    const asked = session.snapshotEvents().findLast(event => event.type === 'approval/asked');
    const pending = (await call('notification-state')).interactions;
    assert.equal(pending.length, 1); assert.equal(pending[0].nativeId, asked.data.id);
    const claim = await call('notification-claim', { clientId: 'installed-service-client', generation });
    assert.equal(claim.notice.sessionId, session.id); assert.deepEqual(claim.notice.requestIds, [pending[0].id]);
    for (const state of ['requested', 'shown', 'clicked']) {
      assert.equal((await call('notification-receipt', { token: claim.token, clientId: claim.clientId, noticeId: claim.notice.id, generation, state, time: Date.now() })).accepted, true);
    }
    assert.equal((await call('notification-state')).interactions.length, 1, 'opening a notification cannot decide approval');
    approvalAnswer('allowed-once'); assert.equal(await approval, 'allowed-once');
    assert.equal((await call('notification-state')).interactions.length, 0);
    assert.equal(session.snapshotEvents().findLast(event => event.type === 'approval/decided').data.id, asked.data.id);
    cases.approvalServiceThroughInstalledPlugin = true;

    const callId = 'installed-timed-question-full', questions = [{ id: 'choice', question: 'Choose A or B', options: [{ label: 'A' }, { label: 'B' }] }];
    session.append('turn/start', { turn: 2 });
    session.append('request/header', { reason: 'initial', header: { tools: [{ name: 'ask_user_question', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }] } });
    session.append('tool/call', { turn: 2, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) });
    const timed = ctx.userQuestions.askTimed({ agent, questions }, callId, 100);
    assert.equal((await call('notification-state')).interactions[0].nativeId, callId);
    const result = await timed; assert.deepEqual(result, { pending: true, callId });
    session.append('tool/result', { turn: 2, step: 1, message: { role: 'tool', id: 'timed-result', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) }] } }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    const continued = (await call('notification-state')).interactions;
    assert.equal(continued.length, 1); assert.equal(continued[0].state, 'continued'); assert.equal(continued[0].nativeId, callId);
    assert.equal((await call('notification-snooze', { interactionId: continued[0].id, generation })).accepted, true);
    const answer = { answers: [{ id: 'choice', selected: ['A'] }] };
    assert.equal(ctx.userQuestions.answer(agent, 'installed-timed-question', answer), false);
    assert.equal((await call('notification-state')).interactions.length, 1);
    session.append('turn/start', { turn: 3 });
    assert.equal(ctx.userQuestions.answer(agent, callId, answer), true);
    assert.equal((await call('notification-state')).interactions.length, 0);
    const reply = session.snapshotEvents().findLast(event => event.type === 'user/message');
    assert.equal(reply.data.source.callId, callId); assert.equal(reply.data.source.outcome, 'answered');
    cases.timedServiceContinuedSnoozeAndExactAnswer = true;

    const abort = new AbortController();
    const blocking = ctx.userQuestions.ask({ agent, questions, signal: abort.signal });
    const cancelled = assert.rejects(blocking, error => error.code === 'ASK_ABORTED');
    assert.equal((await call('notification-state')).interactions.length, 1);
    abort.abort(); await cancelled;
    assert.equal((await call('notification-state')).interactions.length, 0);
    cases.questionServiceCancellationSettlesPlugin = true;

    await ctx.coopanion.command('stop');
    assert.equal(await call('notification-claim', { clientId: claim.clientId, generation }), null);
    await scope.dispose(); assert.equal(routes.size, 0);
    cases.installedServiceCleanup = true;
    return cases;
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
}
