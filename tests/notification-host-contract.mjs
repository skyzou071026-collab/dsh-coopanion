import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { values } = parseArgs({ options: { runtime: { type: 'string' }, version: { type: 'string' } } });
assert.ok(values.runtime && values.version, 'provide the actual DSH runtime and version');
const modules = join(resolve(values.runtime), 'node_modules');
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
for (const name of ['dsh', 'dsh-session', 'dsh-user-approval', 'dsh-user-questions']) {
  const pkg = JSON.parse(await readFile(join(modules, '@deepseek-ai', name, 'package.json'), 'utf8'));
  assert.equal(pkg.version, values.version, `${name} version`);
}
const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { UserQuestionService }, { ApprovalService }] = await Promise.all([
  import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href), load('dsh-session'), load('dsh-session-projection'), load('dsh-user-questions'), load('dsh-user-approval'),
]);
const ctx = new Context();
new SessionProjectionRegistry(ctx); new SessionStore(ctx); new UserQuestionService(ctx); new ApprovalService(ctx, { policy: 'ask' });
await ctx.fiber.await();
const report = { dsh: values.version, pluginVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  kind: 'actual-host-contract', cases: {}, source: 'published DSH services and public projection snapshot', packages: {}, events: [] };
for (const name of ['dsh-session', 'dsh-user-approval', 'dsh-user-questions']) report.packages[name] = createHash('sha256').update(await readFile(join(modules, '@deepseek-ai', name, 'lib/index.js'))).digest('hex');
try {
  const session = ctx.sessions.create('n0-question-contract');
  session.append('turn/start', { turn: 1 });
  session.append('request/header', { reason: 'initial', header: { tools: [{ name: 'ask_user_question', description: 'N0 timed question', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }] } });
  session.append('tool/call', { turn: 1, step: 1, callId: 'n0-call-complete-identity', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'N0 问题' }] }) });
  const view = () => ctx.sessionProjections.snapshot(session, ['userQuestions']).values.userQuestions;
  assert.equal(view().active[0].state, 'open'); report.cases.questionOpen = true;
  session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: 'result', toolCallId: 'n0-call-complete-identity', content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'n0-call-complete-identity' }) }] } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(view().active[0].state, 'continued'); report.cases.continuedSurvivesTurnEnd = true;
  session.append('turn/start', { turn: 2 });
  session.append('user/message', { role: 'user', id: 'unrelated', content: [{ type: 'text', text: '{"answers":[]}' }], source: { kind: 'user-question-reply', callId: 'n0-call', outcome: 'answered' } }, { surfaceOp: 'append' });
  assert.equal(view().active.length, 1); report.cases.prefixReplyCannotSettle = true;
  session.append('user/message', { role: 'user', id: 'late', content: [{ type: 'text', text: '{"answers":[{"id":"q","selected":[],"custom":"回答"}]}' }], source: { kind: 'user-question-reply', callId: 'n0-call-complete-identity', outcome: 'answered' } }, { surfaceOp: 'append' });
  assert.equal(view().active.length, 0); assert.equal(view().settled[0].callId, 'n0-call-complete-identity'); report.cases.exactLateReplySettles = true;
  const approvalEvents = [];
  ctx.on('session/event', (_session, event) => { if (event.type.startsWith('approval/')) approvalEvents.push(event); });
  ctx.on('approval/request', async () => 'allowed-once');
  const agent = { session, ctx };
  assert.equal(await ctx.approval.request({ agent, toolName: 'bash', callId: 'approval-call' }), 'allowed-once');
  assert.equal(approvalEvents.length, 2); assert.equal(approvalEvents[0].type, 'approval/asked'); assert.equal(approvalEvents[1].type, 'approval/decided');
  assert.equal(approvalEvents[0].data.id, approvalEvents[1].data.id); report.cases.approvalNativePair = true;
  const answer = { answers: [{ id: 'q', selected: [], custom: 'N0 answer' }] };
  ctx.on('user-questions/request', async request => { assert.equal(request.questions[0].id, 'q'); return answer; });
  assert.deepEqual(await ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'N0 request' }] }), answer);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'N0 cancelled request' }], signal: abort.signal }), error => error.code === 'ASK_ABORTED');
  report.cases.questionPublicRequestAndCancellation = true;
  report.events = session.snapshotEvents();
  report.cases.stopVocabulary = true;
  for (const reason of [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'interrupted' }, { kind: 'error', error: { code: 'UNKNOWN', message: 'N0' } }, { kind: 'max-tokens' }, { kind: 'blocked' }]) {
    const s = ctx.sessions.create(`n0-${reason.kind}`); s.append('turn/start', { turn: 1 }); s.append('turn/end', { turn: 1, reason }); assert.deepEqual(s.snapshotEvents().at(-1).data.reason, reason);
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally {
  await ctx.fiber.dispose();
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/notification-host-${values.version}.json`, JSON.stringify(report, null, 2) + '\n');
}
console.log(`N0 actual host contract passed: DSH ${values.version}`);
