/** Runs inside the published profile loader. Only the LLM response is scripted. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export const inject = ['appReady', 'appExit', 'llm', 'agentLoop', 'goals', 'sessions', 'sessionProjections', 'sessionController', 'agents', 'tools'];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    setTimeout(async () => {
    try {
      const { LlmAdapter, createUserMessage } = await import(pathToFileURL(join(process.env.M1_MODULES, '@deepseek-ai/dsh-llm/lib/index.js')).href);
      let agent, requests = 0;
      const { Context } = await import(pathToFileURL(join(process.env.M1_MODULES, '@deepseek-ai/cordis/lib/index.js')).href);
      const { mountPet, Config } = await import(pathToFileURL(join(process.env.M1_PLUGIN, 'dist/index.js')).href);
      const petCtx = new Context();
      petCtx.provide('agents', { list: () => agent ? [agent] : [], get: id => agent?.id === id ? agent : undefined, roots: () => agent ? [agent] : [] });
      let lifecycle, snapshot; const notices = [];
      const bridge = {
        onLifecycle: fn => { lifecycle = fn; }, removeLifecycle() {},
        start: async (_options, life) => lifecycle({ running: true, visible: true, generation: life.generation, visibilityRevision: 1 }),
        onAction() {}, removeAction() {}, update: value => { snapshot = value; }, notify() {}, notificationState() {},
        presentRole: notice => { notices.push(notice); return true; }, dispose: async () => {},
      };
      await petCtx.plugin(child => mountPet(child, Config(), bridge)).await();
      const petDeadline = Date.now() + 3000;
      while (petCtx.coopanion.status().phase !== 'running') { assert.ok(Date.now() < petDeadline); await new Promise(resolve => setTimeout(resolve, 5)); }
      class Scripted extends LlmAdapter {
        async listModels() { return [{ provider: 'm1-script', id: 'controlled', name: 'M1 controlled model' }]; }
        async *stream(options) {
          if (options.messages.some(message => message.source?.kind === 'dsh-session-title-llm')) {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'M1 title' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
          const n = ++requests;
          let block;
          if (n === 1) block = { type: 'tool-call', id: 'm1-create-full', name: 'create_goal', arguments: JSON.stringify({ objective: 'M1 controlled goal lifecycle', max_goal_rounds: 6 }) };
          else if (n === 4 || n === 6) {
            const goal = ctx.goals.get(agent);
            block = { type: 'tool-call', id: `m1-update-${n}-full`, name: 'update_goal', arguments: JSON.stringify({ goal_id: goal.id, revision: n === 4 ? goal.revision + 99 : goal.revision, action: 'complete' }) };
          } else block = { type: 'text', text: `M1 full reply ${n}` };
          assert.ok(n <= 9, 'unexpected automatic continuation');
          yield { type: 'block-start', index: 0, blockType: block.type, ...(block.type === 'tool-call' ? { id: block.id, name: block.name } : {}) };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
        }
      }
      ctx.llm.registerAdapter(['m1-script'], new Scripted());
      const created = await ctx.sessionController.create({ sessionId: 'm1-goal-full-session', cwd: process.env.DSH_HOME });
      await ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: 'm1-script', model: 'controlled' });
      agent = ctx.agents.get(created.sessionId);
      const samples = [];
      ctx.on('session/event', (session, event) => {
        if (session.id !== agent.session.id) return;
        petCtx.emit('session/event', session, event);
        if (event.type === 'turn/end' || event.type === 'goal/change') samples.push({ seq: event.seq, projection: ctx.sessionProjections.snapshot(session, ['goal']).values.goal, presentation: { mood: snapshot.mood, completion: snapshot.sessions[0]?.completion, unread: snapshot.sessions[0]?.unread } });
      });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the controlled lifecycle goal' }], source: { kind: 'user' } }));
      const deadline = Date.now() + 20000;
      while (ctx.goals.get(agent)?.phase !== 'complete' || agent.status !== 'idle') {
        assert.ok(Date.now() < deadline, `goal timeout: ${JSON.stringify(agent.session.snapshotEvents())}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      let events = agent.session.snapshotEvents();
      const changes = events.filter(e => e.type === 'goal/change');
      assert.deepEqual(changes.map(e => [e.data.operation, e.data.goal.phase, e.data.goal.revision]), [['create', 'active', 1], ['complete', 'complete', 2]]);
      const rounds = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'goal');
      assert.deepEqual(rounds.map(e => e.data.source.round), [1, 2, 3]);
      assert.ok(rounds.every(e => e.data.source.goalId === changes[0].data.goal.id && e.data.source.revision === 1));
      const ends = events.filter(e => e.type === 'turn/end');
      assert.equal(ends.length, 4); assert.ok(ends.every(e => e.data.reason.kind === 'completed'));
      assert.ok(changes[0].seq < ends[0].seq, 'first human turn creates goal before turn/end');
      assert.ok(changes[1].seq < ends.at(-1).seq, 'successful update commits before final turn/end');
      assert.equal(events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'm1-update-4-full').data.message.isError, true);
      assert.deepEqual(notices.map(n => n.category), ['goal-progress', 'goal-progress', 'goal-progress', 'completed']);
      assert.equal(snapshot.mood, 'happy'); assert.equal(snapshot.results.length, 4); assert.equal(snapshot.sessions[0].unread, 4);
      assert.deepEqual(snapshot.results.map(r => r.text), ['M1 full reply 2', 'M1 full reply 3', 'M1 full reply 5', 'M1 full reply 7']);
      assert.equal(notices.at(-1).goal.id, changes[0].data.goal.id);
      // The production round driver commits round-limit AFTER turn/end.
      ctx.goals.create(agent, { objective: 'Exercise automatic round cap', maxGoalRounds: 1 });
      const capDeadline = Date.now() + 10000;
      while (ctx.goals.get(agent)?.phase !== 'blocked' || agent.status !== 'idle') { assert.ok(Date.now() < capDeadline, 'round-limit timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(notices.at(-1).category, 'blocked'); assert.equal(snapshot.mood, 'waiting');
      const limit = agent.session.snapshotEvents().findLast(e => e.type === 'goal/change');
      const lastEnd = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
      assert.ok(limit.seq > lastEnd.seq); assert.equal(limit.data.goal.blockedReason.code, 'round-limit');
      let goal = ctx.goals.get(agent); ctx.goals.clear(agent, goal);
      goal = ctx.goals.create(agent, { objective: 'Exercise public mutations', maxGoalRounds: 3 }); ctx.goals.disarm(agent);
      goal = ctx.goals.edit(agent, goal, { objective: 'Edited objective' });
      goal = ctx.goals.pause(agent, goal); goal = ctx.goals.resume(agent, goal); ctx.goals.disarm(agent);
      goal = ctx.goals.block(agent, goal, { code: 'external-blocker', message: 'Waiting for controlled input' });
      ctx.goals.clear(agent, goal);
      assert.equal(ctx.sessionProjections.snapshot(agent.session, ['goal']).values.goal, null);
      assert.equal(snapshot.mood, 'idle'); assert.equal(snapshot.sessions[0].completion, undefined);
      events = agent.session.snapshotEvents().filter(e => ['turn/start', 'turn/end', 'goal/change', 'tool/call', 'tool/result'].includes(e.type) || e.type === 'user/message' && ['user', 'goal'].includes(e.data.source.kind));
      await petCtx.fiber.dispose();
      process.send?.({ type: 'm1-result', result: { status: 'pass', requests, samples, events, results: snapshot.results, cases: { firstHumanTurn: true, automaticRounds: true, failedUpdateDoesNotCommit: true, committedCompleteBeforeTurnEnd: true, installedPresentation: true, roundLimitAfterTurnEnd: true, editPauseResumeBlockClear: true } } });
    } catch (error) { process.send?.({ type: 'm1-result', error: String(error.stack ?? error) }); }
    }, 0);
  }));
  ctx.effect(() => {
    const listener = message => { if (message?.type === 'shutdown-host') ctx.appExit(0); };
    process.on('message', listener); return () => process.off('message', listener);
  });
}
