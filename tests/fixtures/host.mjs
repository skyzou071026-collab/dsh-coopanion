/** Test-only app mounted by the published DSH CLI, using its real session store. */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export const inject = ['sessions', 'appReady', 'appExit', 'webServer', 'connection', 'settings', 'sessionController', 'agents', 'llm', 'sessionPersistence'];

export function apply(ctx) {
  let session;
  let m3Abort, m3Approval, m3Agent, m3Turn;
  let releaseSecondReply;
  ctx.on('approval/request', (request, next) => request.callId === 'm3-installed-pending-full' ? new Promise(() => {}) : next(), { prepend: true });
  const sessions = new Map();
  const action = async message => {
    if (message?.type === 'shutdown-host') {
      ctx.appExit(0);
    } else if (message?.type === 'prepare-m2-cold') {
      try {
        const { LlmAdapter } = await import(pathToFileURL(join(process.env.COOPANION_TEST_MODULES, '@deepseek-ai/dsh-llm/lib/index.js')).href);
        let replies = 0;
        const secondReply = new Promise(resolve => { releaseSecondReply = resolve; });
        class Controlled extends LlmAdapter {
          async listModels() { return [{ provider: 'm2-installed', id: 'controlled', name: 'M2 installed controlled' }]; }
          async *stream(options) {
            const title = options.messages.some(message => message.source?.kind === 'dsh-session-title-llm');
            if (!title && ++replies === 2) await secondReply;
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'M2 installed full result 🐳' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        }
        ctx.llm.registerAdapter(['m2-installed'], new Controlled());
        const owned = await ctx.agents.create({ sessionId: 'm2-installed-cold-full', meta: { cwd: process.env.DSH_HOME }, agentOptions: { provider: 'm2-installed', model: 'controlled' } });
        await ctx.sessionController.selectModel({ sessionId: owned.agent.id, provider: 'm2-installed', model: 'controlled' });
        await ctx.sessions.flush(owned.agent.session); await owned.dispose();
        process.send?.({ type: 'm2-cold-ready', cold: ctx.agents.get('m2-installed-cold-full') === undefined });
      } catch (error) { process.send?.({ type: 'm2-cold-ready', error: String(error.stack ?? error) }); }
    } else if (message?.type === 'prepare-m3-pending') {
      try {
        const agent = ctx.agents.get('m2-installed-cold-full');
        if (!agent || !ctx.get('approval')) throw new Error('M3 approval service unavailable');
        // Admission is not completion. Keep the second reply pending until this
        // boundary, then wait for its real turn/end before opening the M3 fixture.
        const previousReplyPending = agent.status === 'running';
        releaseSecondReply();
        await agent.whenIdle();
        m3Agent = agent; m3Turn = (agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1;
        agent.session.append('turn/start', { turn: m3Turn });
        m3Abort = new AbortController();
        m3Approval = ctx.get('approval').request({ agent, toolName: 'bash', callId: 'm3-installed-pending-full', signal: m3Abort.signal });
        await new Promise(resolve => setTimeout(resolve, 20));
        const event = agent.session.snapshotEvents().findLast(event => event.type === 'approval/asked');
        if (!event || event.data.callId !== 'm3-installed-pending-full') throw new Error('M3 approval was not recorded');
        process.send?.({ type: 'm3-pending-ready', approvalId: event.data.id, previousReplyPending });
      } catch (error) { process.send?.({ type: 'm3-pending-ready', error: String(error.stack ?? error) }); }
    } else if (message?.type === 'cancel-m3-pending') {
      m3Abort?.abort(); await m3Approval;
      m3Agent.session.append('turn/end', { turn: m3Turn, reason: { kind: 'aborted' } });
      process.send?.({ type: 'm3-pending-cancelled' });
    } else if (message?.type === 'read-m2-records') {
      try {
        const session = ctx.sessions.get('m2-installed-cold-full'); if (session) await ctx.sessions.flush(session);
        const read = await ctx.sessionPersistence.open('m2-installed-cold-full', 'read');
        try { process.send?.({ type: 'm2-records', events: (await read.read()).events }); } finally { await read.close(); }
      } catch (error) { process.send?.({ type: 'm2-records', error: String(error.stack ?? error) }); }
    } else if (message?.type === 'verify-installed-services') {
      try {
        const { verifyInstalledServices } = await import(pathToFileURL(message.helper).href);
        const cases = await verifyInstalledServices({ modules: message.modules, plugin: message.plugin });
        process.send?.({ type: 'installed-services-verified', cases });
      } catch (error) { process.send?.({ type: 'installed-services-verified', error: String(error.stack ?? error) }); }
    } else if (message?.type === 'start-task') {
      const id = message.sessionId ?? 'host-install';
      session = ctx.sessions.create(id, { meta: { cwd: id === 'host-install' ? '/test/安装验证' : '/test/第二会话' } });
      sessions.set(id, session);
      session.append('turn/start', { turn: 1 });
    } else if (message?.type === 'finish-task' && (session = sessions.get(message.sessionId ?? 'host-install'))) {
      session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', id: randomUUID(), content: [{ type: 'text', text: `${message.sessionId === 'host-other' ? '第二会话' : '安装验证'}的最终回复。任务已完成。` }], source: { kind: 'model', provider: 'test', model: 'test' } }, stream: [] }, { surfaceOp: 'append' });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      process.send?.({ type: 'session-log', events: session.log.map(event => event.type) });
    } else if (message?.type === 'follow-system-language') {
      try {
        await ctx.settings.mutate('locale', [{ op: 'unset', path: ['preference'] }]);
        process.send?.({ type: 'system-language-ready' });
      } catch (error) { process.send?.({ type: 'system-language-ready', error: String(error) }); }
    }
  };
  ctx.effect(() => {
    process.on('message', action);
    return () => process.off('message', action);
  });
  ctx.effect(() => ctx.appReady.onReady(async () => {
    const probe = await import('./notification-probe.mjs');
    await ctx.plugin(probe).await();
    const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).filter(fiber => fiber.parent.fiber.runtime?.name === 'dsh-coopanion');
    const errors = [];
    for (const fiber of fibers) { try { await fiber.await(); } catch (error) { errors.push(String(error)); } }
    const descriptor = ctx.settings.describe().find(entry => entry.ns === 'dsh-coopanion');
    process.send?.({ type: 'host-ready', url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`), services: { errors, customSettingsPage: descriptor?.autoGenerate === false, preferences: descriptor?.value } });
  }));
}
