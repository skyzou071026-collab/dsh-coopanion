import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { Config, mountPet } from '../src/index.ts';
import type { PetBridge } from '../src/bridge.ts';
import type { PetSnapshot } from '../src/model.ts';

function history(id: string, completed = true) {
  const session = Session.create(SessionId(id));
  for (let turn = 1; turn <= 2; turn++) {
    session.append('turn/start', { turn });
    session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: `Historical reply ${turn}` }], source: { provider: 'test', model: 'test' } }), stream: [] }, { surfaceOp: 'append' });
    if (turn === 1 || completed) session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return session.snapshotEvents();
}

async function host(seed?: ReturnType<typeof history>, status: Agent['status'] | null = 'idle') {
  const ctx = new Context();
  // Use the published store's seed/announcement path; seed events do not emit session/event.
  new SessionStore(ctx);
  const agents: Agent[] = [];
  ctx.provide('agents', { list: () => agents });
  if (seed) {
    const session = ctx.sessions.create(SessionId('last-open-session'), { seed });
    if (status) agents.push({ id: session.id, session, ctx, status } as Agent);
  }
  let action: ((value: unknown) => void) | undefined;
  const bridge: PetBridge = {
    start: vi.fn(async () => {}), update: vi.fn(), notify: vi.fn(), notificationState: vi.fn(), dispose: vi.fn(async () => {}),
    onAction: listener => { action = listener; }, removeAction: () => { action = undefined; },
  };
  const scope = ctx.plugin(child => mountPet(child, Config({ autoStart: false }), bridge));
  await scope.await();
  const snapshot = () => vi.mocked(bridge.update).mock.calls.at(-1)![0] as PetSnapshot;
  const open = async (id: string, seed: ReturnType<typeof history>) => {
    const session = ctx.sessions.create(SessionId(id), { seed });
    const agent = { id: session.id, session, ctx, status: 'idle' } as Agent;
    agents.push(agent);
    await ctx.serial('agent/created', { agent, source: 'resume' });
    return agent;
  };
  return { ctx, agents, bridge, snapshot, open, action: (value: unknown) => action?.(value), dispose: async () => { await scope.dispose(); await ctx.fiber.dispose(); } };
}

it('opening a historical session keeps old replies out of the unread inbox', async () => {
  const h = await host();
  try {
    const agent = await h.open('historical-session', history('historical-session'));
    expect(h.snapshot().sessions[0].unread).toBe(0);
    expect(h.snapshot().results).toHaveLength(2);
    expect(h.snapshot().results.every(result => result.read)).toBe(true);
    expect(h.snapshot()).toMatchObject({ active: false, mood: 'idle' });
    expect(h.bridge.notify).not.toHaveBeenCalled();

    agent.session.append('turn/start', { turn: 3 });
    agent.session.append('assistant/message', { turn: 3, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'New live reply' }], source: { provider: 'test', model: 'test' } }), stream: [] }, { surfaceOp: 'append' });
    agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    expect(h.snapshot().sessions[0].unread).toBe(1);
    expect(h.snapshot().results.filter(result => !result.read).map(result => result.text)).toEqual(['New live reply']);
    await h.ctx.serial('agent/created', { agent, source: 'resume' });
    await h.ctx.coopanion.command('restart');
    expect(h.snapshot().sessions[0].unread).toBe(1);
    const result = h.snapshot().results.at(-1)!;
    h.action({ type: 'read', resultId: result.id });
    expect(h.snapshot().sessions[0].unread).toBe(0);
    // Agent creation/restore may be repeated; it must not replay old unread results.
    await h.ctx.serial('agent/created', { agent, source: 'resume' });
    expect(h.snapshot().sessions[0].unread).toBe(0);
  } finally { await h.dispose(); }
});

it.each(['idle', null] as const)('restarting with Agent status %s does not animate unfinished historical output', async status => {
  const h = await host(history('last-open-session', false), status);
  try {
    expect(h.snapshot()).toMatchObject({ mood: 'idle', active: false, streaming: false });
    expect(h.snapshot().sessions[0].unread).toBe(0);
    expect(h.bridge.notify).not.toHaveBeenCalled();
  } finally { await h.dispose(); }
});

it('retains actual running activity and follows subsequent live status and output', async () => {
  const h = await host(history('last-open-session', false), 'running');
  try {
    expect(h.snapshot()).toMatchObject({ mood: 'talking', active: true });
    expect(h.snapshot().sessions[0].unread).toBe(0);
    const agent = h.agents[0];
    h.ctx.emit('agent/status', { agent, status: 'idle' });
    expect(h.snapshot()).toMatchObject({ mood: 'idle', active: false });
    h.ctx.emit('agent/status', { agent, status: 'running' });
    expect(h.snapshot()).toMatchObject({ mood: 'thinking', active: true });
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    expect(h.snapshot().results.filter(result => !result.read).map(result => result.text)).toEqual(['Historical reply 2']);
    expect(h.snapshot().sessions[0].unread).toBe(1);
  } finally { await h.dispose(); }
});

it('keeps a restored pending approval visible without claiming its Agent is running', async () => {
  const source = Session.create(SessionId('last-open-session'));
  source.append('turn/start', { turn: 1 });
  const id = ApprovalRequestId('restored-approval-full');
  source.append('approval/asked', { id, toolName: 'bash' });
  const h = await host(source.snapshotEvents());
  try {
    expect(h.snapshot()).toMatchObject({ mood: 'waiting', active: false });
    expect(vi.mocked(h.bridge.notificationState!).mock.calls.at(-1)![0].interactions).toHaveLength(1);
    expect(h.bridge.notify).not.toHaveBeenCalled();
    await h.ctx.serial('agent/created', { agent: h.agents[0], source: 'resume' });
    expect(h.snapshot()).toMatchObject({ mood: 'waiting', active: false });
    h.agents[0].session.append('approval/decided', { id, outcome: 'rejected' });
    expect(h.snapshot()).toMatchObject({ mood: 'idle', active: false });
  } finally { await h.dispose(); }
});

it('lists cold public sessions without activating agents, restores history as read and retains detached targets', async () => {
  const ctx = new Context(); const agents: Agent[] = []; ctx.provide('agents', { list: () => agents });
  const cold = Session.create(SessionId('cold-full'), history('cold-full'), { id: SessionId('cold-full'), version: 4, createdAt: 0, isSeeded: false, cwd: '/project' });
  const prompt = vi.fn(async () => ({ accepted: true }));
  ctx.provide('sessionController', { list: async () => ({ items: [{ sessionId: cold.id }, { sessionId: 'child', origin: 'subagent' }] }), prompt });
  const observed = { header: cold.header, events: cold.snapshotEvents(), [Symbol.dispose]: vi.fn() };
  const observeSession = vi.fn(async () => observed); ctx.provide('sessionQuery', { observeSession });
  const bridge: PetBridge = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}), update: vi.fn(), notify: vi.fn(), onAction() {}, removeAction() {} };
  const scope = ctx.plugin(child => mountPet(child, Config({ autoStart: false }), bridge));
  try {
    await scope.await(); await vi.waitFor(() => expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ id: cold.id, chatAvailable: true, unread: 0 })] })));
    const snapshot = vi.mocked(bridge.update).mock.calls.at(-1)![0];
    expect(snapshot.results).toHaveLength(2); expect(snapshot.results.every(r => r.read)).toBe(true);
    expect(prompt).not.toHaveBeenCalled(); expect(agents).toHaveLength(0); expect(observeSession).toHaveBeenCalledTimes(1); expect(observed[Symbol.dispose]).toHaveBeenCalledOnce();
    ctx.emit('api-session/removed', cold.id); ctx.emit('session/disposed', cold);
    expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: cold.id, sessions: [expect.objectContaining({ id: cold.id })] }));
    expect(bridge.notify).not.toHaveBeenCalled();
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});
