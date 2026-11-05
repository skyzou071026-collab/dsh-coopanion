/** Published Host contract probe: real controller, queue, persistence and loop; scripted model only. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { chmod, readdir } from 'node:fs/promises';
export const inject = ['appReady', 'appExit', 'llm', 'agents', 'sessions', 'sessionController', 'sessionPersistence'];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { setTimeout(async () => {
    try {
      const { LlmAdapter } = await import(pathToFileURL(join(process.env.M2_MODULES, '@deepseek-ai/dsh-llm/lib/index.js')).href);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      class Controlled extends LlmAdapter {
        async listModels() { return [{ provider: 'm2-script', id: 'controlled', name: 'M2 controlled' }]; }
        async *stream() { await gate; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'M2 full result' } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
      }
      const unregisterAdapter = ctx.llm.registerAdapter(['m2-script'], new Controlled());
      const sessionId = 'm2-cold-ordinary-full-identity';
      const owned = await ctx.agents.create({ sessionId, meta: { cwd: process.env.DSH_HOME }, agentOptions: { provider: 'm2-script', model: 'controlled' } });
      await ctx.sessionController.selectModel({ sessionId, provider: 'm2-script', model: 'controlled' });
      await ctx.sessions.flush(owned.agent.session); await owned.dispose();
      assert.equal(ctx.agents.get(sessionId), undefined); assert.equal(ctx.sessions.get(sessionId), undefined);
      const input = { sessionId, requestId: 'm2-client-request-cold-full-00000001', mode: 'queue', content: [{ type: 'text', text: '精确消息 🐳\nnext line' }], clientTimeZone: 'Asia/Shanghai' };
      const receipts = [await ctx.sessionController.prompt(input, new AbortController().signal)];
      const agent = ctx.agents.get(sessionId); assert.ok(agent);
      await ctx.sessions.flush(agent.session);
      const read = await ctx.sessionPersistence.open(sessionId, 'read');
      let persisted; try { persisted = (await read.read()).events; } finally { await read.close(); }
      const messages = (events, id) => [...new Map(events.flatMap(e => e.type === 'agent/inbox/spliced' ? e.data.inserted : e.type === 'user/message' ? [e.data] : []).filter(m => m.source.rpcId === id).map(m => [m.id, m])).values()];
      const occurrences = events => messages(events, input.requestId);
      assert.equal(occurrences(persisted).length, 1); assert.deepEqual(occurrences(persisted)[0].content, input.content);
      assert.equal(occurrences(persisted)[0].source.clientTimeZone, input.clientTimeZone);
      receipts.push(await ctx.sessionController.prompt(input, new AbortController().signal));
      const sequentialRetryCount = occurrences(agent.session.snapshotEvents()).length;
      const lateAbort = new AbortController();
      const afterStart = ctx.sessionController.prompt({ ...input, requestId: 'm2-cancel-after-start-full' }, lateAbort.signal); lateAbort.abort();
      const cancellationAfterStartReceipt = await afterStart; assert.equal(cancellationAfterStartReceipt.accepted, true);
      const concurrent = { ...input, requestId: 'm2-client-request-concurrent-full-00000002' };
      receipts.push(...await Promise.all([ctx.sessionController.prompt(concurrent, new AbortController().signal), ctx.sessionController.prompt(concurrent, new AbortController().signal)]));
      const concurrentCount = messages(agent.session.snapshotEvents(), concurrent.requestId).length;
      const failures = {};
      const failure = async (name, request, signal = new AbortController().signal) => { try { await ctx.sessionController.prompt(request, signal); throw new Error('unexpected acceptance'); } catch (e) { assert.notEqual(e.message, 'unexpected acceptance'); failures[name] = { code: e.code, name: e.name, message: e.message }; } };
      await failure('missing', { ...input, sessionId: 'm2-missing-full' });
      await failure('invalidTimeZone', { ...input, clientTimeZone: 'bad-zone' });
      const cancel = new AbortController(); cancel.abort(); await failure('cancelledBeforeAdmission', { ...input, requestId: 'm2-cancelled-full' }, cancel.signal);
      const locked = await ctx.sessionPersistence.create({ id: 'm2-locked-full', version: 4, createdAt: Date.now(), isSeeded: false, cwd: process.env.DSH_HOME });
      await locked.flush(); await failure('writerHeld', { ...input, sessionId: locked.id }); await locked.close();
      release();
      const deadline = Date.now() + 10000;
      while (agent.status !== 'idle' || agent.inbox.nextTurn.length) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
      await ctx.sessions.flush(agent.session);
      let plugin;
      if (process.env.M2_VERIFY_PLUGIN === '1') {
        const { mountPet, Config } = await import(pathToFileURL(join(process.env.M2_PLUGIN, 'dist/index.js')).href);
        const pluginId = 'm2-plugin-cold-full-identity';
        const ownedCold = await ctx.agents.create({ sessionId: pluginId, meta: { cwd: process.env.DSH_HOME }, agentOptions: { provider: 'm2-script', model: 'controlled' } });
        await ctx.sessionController.selectModel({ sessionId: pluginId, provider: 'm2-script', model: 'controlled' });
        await ctx.sessions.flush(ownedCold.agent.session); await ownedCold.dispose();
        let action, snapshot; const results = [];
        const bridge = { start: async () => {}, dispose: async () => {}, update: v => { snapshot = v; }, notify() {}, onAction: fn => { action = fn; }, removeAction() {}, chatResult: v => results.push(v) };
        const mounted = () => ctx.isolate('coopanion').isolate('connection').plugin(child => mountPet(child, Config({ autoStart: false }), bridge));
        const wait = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline, JSON.stringify({ results, snapshot })); await new Promise(r => setTimeout(r, 10)); } };
        let scope = mounted(); await scope.await();
        await wait(() => snapshot.sessions.some(s => s.id === pluginId));
        assert.equal(snapshot.sessions.find(s => s.id === pluginId).unread, 0);
        assert.equal(ctx.agents.get(pluginId), undefined, 'history listing does not activate cold agent');
        const message = { type: 'chat', sessionId: pluginId, requestId: 'm2-plugin-client-full-request-00000001', text: 'Installed exact message 🐳\n下一行', clientTimeZone: 'Asia/Shanghai' };
        action(message); action(message); action({ type: 'select', sessionId });
        await wait(() => results.length === 2);
        assert.ok(results.every(r => r.status === 'accepted'), JSON.stringify(results));
        assert.equal(snapshot.sessionId, sessionId, 'in-flight submission never changes later explicit focus');
        const resumed = ctx.agents.get(pluginId); assert.ok(resumed);
        assert.equal(messages(resumed.session.snapshotEvents(), message.requestId).length, 1);
        action({ ...message, text: 'changed identity' }); await wait(() => results.length === 3);
        assert.equal(results.at(-1).code, 'coopanion/request-conflict');
        await ctx.sessions.flush(resumed.session);
        await scope.dispose(); scope = mounted(); await scope.await();
        action(message); await wait(() => results.length === 4);
        assert.equal(results.at(-1).status, 'accepted');
        assert.equal(messages(resumed.session.snapshotEvents(), message.requestId).length, 1, 'lost receipt retry after new admission instance stays once');
        action({ ...message, requestId: 'm2-plugin-client-full-request-00000002' }); await wait(() => results.length === 5);
        assert.equal(results.at(-1).status, 'accepted');
        const sub = await ctx.agents.create({ sessionId: 'm2-subagent-full', meta: { cwd: process.env.DSH_HOME, origin: 'subagent', parentSession: sessionId }, agentOptions: { provider: 'm2-script', model: 'controlled' } });
        action({ ...message, sessionId: sub.agent.session.id, requestId: 'm2-plugin-reject-subagent' }); await wait(() => results.length === 6);
        assert.equal(results.at(-1).code, 'session/subagent-owned'); await sub.dispose();
        action({ ...message, sessionId: 'm2-absent-full', requestId: 'm2-plugin-reject-missing' }); await wait(() => results.length === 7);
        assert.equal(results.at(-1).code, 'session/not-found');
        await wait(() => resumed.status === 'idle' && !resumed.inbox.nextTurn.length);
        await ctx.sessions.flush(resumed.session);
        const disk = await ctx.sessionPersistence.open(pluginId, 'read'); let events;
        try { events = (await disk.read()).events; } finally { await disk.close(); }
        assert.deepEqual(messages(events, message.requestId)[0].content, [{ type: 'text', text: message.text }]);
        let permission = { kind: 'posix-mode', status: 'skipped-windows' };
        if (process.platform !== 'win32') {
          const deniedId = 'm2-permission-denied-full';
          const denied = await ctx.sessionPersistence.create({ id: deniedId, version: 4, createdAt: Date.now(), isSeeded: false, cwd: process.env.DSH_HOME });
          await denied.flush(); await denied.close();
          const entries = await readdir(ctx.sessionPersistence.config.root, { recursive: true, withFileTypes: true });
          const directory = entries.find(entry => entry.isDirectory() && entry.name === deniedId);
          assert.ok(directory, 'find isolated persistence directory');
          const path = join(directory.parentPath, directory.name);
          await chmod(path, 0);
          try {
            action({ ...message, sessionId: deniedId, requestId: 'm2-plugin-permission-denied' }); await wait(() => results.length === 8);
            assert.equal(results.at(-1).code, 'gateway/forbidden'); permission = { kind: 'posix-mode', status: 'pass', receipt: results.at(-1) };
          } finally { await chmod(path, 0o700); }
        }
        const beforeNoModel = results.length;
        unregisterAdapter();
        action({ ...message, requestId: 'm2-plugin-no-model' }); await wait(() => results.length === beforeNoModel + 1);
        assert.equal(results.at(-1).code, 'session/model-unavailable');
        plugin = { message, results, events, snapshot, permission, cases: { coldListingWithoutActivation: true, historyReadBaseline: true, coldControllerAdmission: true, exactPersistedIdentity: true, concurrentOnce: true, conflictRejected: true, lostReceiptRestartRetryOnce: true, distinctRequestQueued: true, inFlightFocusStable: true, subagentRejected: true, missingRejected: true, unavailableModelRejected: true } };
        await scope.dispose();
      }
      process.send?.({ type: 'm2-result', result: { status: 'pass', plugin, input, cancellationAfterStartReceipt, receipts, persisted, sequentialRetryCount, concurrentCount, failures, events: agent.session.snapshotEvents(), cases: { coldRecovery: true, durableExactIdentity: true, sequentialRetryOnce: sequentialRetryCount === 1 } } });
    } catch (error) { process.send?.({ type: 'm2-result', error: String(error.stack ?? error) }); }
  }, 0); }));
  ctx.effect(() => { const fn = m => { if (m?.type === 'shutdown-host') ctx.appExit(0); }; process.on('message', fn); return () => process.off('message', fn); });
}
