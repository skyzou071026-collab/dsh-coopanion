import { it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { Config, mountPet } from '../src/index.ts';
import type { NativeLifecycle, PetBridge } from '../src/bridge.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval';
import { LlmAttemptId } from '@deepseek-ai/dsh-llm';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';

function nativeBridge(): PetBridge {
  const listeners = new Set<(state: NativeLifecycle) => void>(); let generation = 0, revision = 0;
  const bridge: PetBridge = {
    start: vi.fn(async (_options, lifetime) => { generation = lifetime?.generation ?? generation + 1; revision = 1; for (const fn of listeners) fn({ running: true, visible: true, generation, visibilityRevision: revision, suspended: false }); }),
    update: vi.fn(), chatResult: vi.fn(), notify: vi.fn(() => true), dispose: vi.fn(async () => {}), onAction: vi.fn(), removeAction: vi.fn(),
    onLifecycle: fn => { listeners.add(fn); }, removeLifecycle: fn => { listeners.delete(fn); },
    control: vi.fn(command => { for (const fn of listeners) fn({ running: true, visible: command !== 'hide', generation, visibilityRevision: ++revision, suspended: false }); }),
    notificationState: vi.fn(), snoozeResult: vi.fn(),
    presentRole: vi.fn((notice, runtime) => { if (!runtime.visible || runtime.generation !== generation) return false; return bridge.notify(notice); }),
  };
  return bridge;
}

it('boots in the durable Harness language and reacts to locale settings independently of notifications', async () => {
  const ctx = new Context(); let preference: string | undefined = 'en';
  ctx.provide('agents', { list: () => [] });
  const describe = vi.fn(() => [{ ns: 'locale', value: { preference } }]);
  ctx.provide('settings', { describe, mutate: vi.fn() });
  const bridge = { ...nativeBridge(), configure: vi.fn() };
  const fiber = ctx.plugin(async ctx => mountPet(ctx, Config({ notifications: false }), bridge));
  try {
    await fiber.await(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
    expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', notifications: false }), expect.anything());
    expect(describe).toHaveBeenCalledWith({ redactSecrets: true });
    preference = 'zh'; ctx.emit('settings/document-updated', 'locale' as SettingsNamespace, 1);
    expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'zh' }));
    preference = undefined; ctx.emit('settings/document-updated', 'locale' as SettingsNamespace, 2);
    expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ locale: undefined }));
  } finally { await fiber.dispose(); await ctx.fiber.dispose(); }
});

it('uses the real Cordis event bus, delegates approval, logs user input through the agent, and releases resources', async () => {
  const ctx = new Context();
  const session = { id: SessionId('live'), header: { origin: undefined, version: 4, id: SessionId('live'), createdAt: 0, isSeeded: false, cwd: '/project/live' } } as Session;
  const followup = vi.fn();
  const prompt = vi.fn(async () => ({ accepted: true }));
  ctx.provide('sessionController', { prompt, list: async () => ({ items: [] }), modelCatalog: async () => ({ default: { provider: 'test', model: 'test' }, groups: [{ id: 'test', models: [{ id: 'test' }] }] }) });
  ctx.provide('sessionQuery', { observeSession: async () => ({ header: session.header, events: [], [Symbol.dispose]() {} }) });
  const agent: Agent = {
    id: session.id, session, followup, ctx, options: {}, status: 'idle',
    inbox: { nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {}, replace: () => false, remove: () => false, splice: () => [] },
    cancel() {}, send() {}, steer() {}, inject() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
  };
  ctx.provide('agents', { list: () => [agent], withInitiator: (_agent: Agent, fn: () => void) => fn() });
  let action: ((action: unknown) => void) | undefined;
  const bridge: PetBridge = { ...nativeBridge(), onAction: fn => { action = fn; }, removeAction: () => { action = undefined; } };
  const fiber = ctx.plugin(async ctx => mountPet(ctx, Config(), bridge));
  await fiber.await();
  await vi.waitFor(() => expect(ctx.coopanion.status().phase).toBe('running'));
  expect(bridge.start).toHaveBeenCalledOnce();
  const fresh = { id: SessionId('fresh'), header: { origin: undefined, version: 4, id: SessionId('fresh'), createdAt: 1, isSeeded: false, cwd: '/project/fresh' } } as Session;
  ctx.emit('session/created', fresh);
  expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'live', mood: 'idle' }));
  ctx.emit('session/event', session, { seq: SessionSeq(0), type: 'turn/start', data: { turn: 1 }, time: 0 });
  expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'live', mood: 'thinking' }));
  ctx.emit('session/event', fresh, { seq: SessionSeq(0), type: 'turn/start', data: { turn: 1 }, time: 0 });
  expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'live', mood: 'thinking' }));
  const attemptId = LlmAttemptId('live-attempt');
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 } });
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '实时回复' } } });
  await vi.waitFor(() => expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'live', results: [], sessions: expect.arrayContaining([expect.objectContaining({ id: 'live', mood: 'talking', reply: '', streaming: true })]) })));
  ctx.emit('session/event', session, { seq: SessionSeq(1), type: 'approval/asked', data: { id: ApprovalRequestId('native-approval'), toolName: 'bash' }, time: 1 });
  const delegated = vi.fn(async () => ({ status: 'denied' }));
  const outcome = await ctx.waterfall('approval/request', { agent, toolName: 'bash' }, delegated as never);
  expect(outcome).toEqual({ status: 'denied' }); expect(delegated).toHaveBeenCalledOnce();
  expect(bridge.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'live · 等你确认', category: 'approval', requestIds: ['[\"live\",\"approval\",\"native-approval\"]'] }));
  ctx.emit('session/event', session, { seq: SessionSeq(2), type: 'approval/decided', data: { id: ApprovalRequestId('native-approval'), outcome: 'rejected' }, time: 2 });
  action?.({ type: 'chat', sessionId: 'live', text: '  你好  ', requestId: 'full-client-1', clientTimeZone: 'Asia/Shanghai' });
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live', requestId: 'full-client-1', mode: 'queue', content: [{ type: 'text', text: '你好' }], clientTimeZone: 'Asia/Shanghai' }), expect.anything()));
  action?.({ type: 'chat', sessionId: 'live', text: 'x'.repeat(2001), requestId: 'invalid', clientTimeZone: 'UTC' });
  expect(followup).not.toHaveBeenCalled(); expect(prompt).toHaveBeenCalledTimes(1);
  await fiber.dispose(); expect(action).toBeUndefined(); expect(bridge.dispose).toHaveBeenCalledOnce();
  await ctx.fiber.dispose();
});

it('rejects invalid configuration before starting a desktop process', () => {
  expect(() => Config({ size: 500 })).toThrow();
  expect(() => Config({ bubbleDurationMs: 0 })).toThrow();
});

it('keeps the plugin mounted when launch fails, and honors disabled auto-start', async () => {
  const ctx = new Context(); ctx.provide('agents', { list: () => [] });
  const bridge: PetBridge = { start: vi.fn(async () => { throw new Error('test: no display'); }), update: vi.fn(), chatResult: vi.fn(), notify: vi.fn(() => true), onAction: vi.fn(), removeAction: vi.fn(), dispose: vi.fn(async () => {}) };
  const fiber = ctx.plugin(async scope => mountPet(scope, Config({ autoStart: false }), bridge));
  await fiber.await(); expect(bridge.start).not.toHaveBeenCalled();
  expect(ctx.coopanion.status().phase).toBe('stopped');
  expect((await ctx.coopanion.command('start')).phase).toBe('error');
  expect(ctx.coopanion.status().error).toBe('test: no display');
  await fiber.dispose(); await ctx.fiber.dispose();
});

it('acknowledges desktop preference changes through the shared host configuration', async () => {
  const ctx = new Context(); ctx.provide('agents', { list: () => [] });
  let action: ((value: unknown) => void) | undefined;
  const bridge: PetBridge = { start: vi.fn(async () => {}), update: vi.fn(), chatResult: vi.fn(), notify: vi.fn(() => true), configure: vi.fn(), onAction: fn => { action = fn; }, removeAction: vi.fn(), dispose: vi.fn(async () => {}) };
  const fiber = ctx.plugin(scope => mountPet(scope, Config({ autoStart: false }), bridge)); await fiber.await();
  action?.({ type: 'preference', field: 'roam', value: false });
  await vi.waitFor(() => expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ roam: false, notifications: true })));
  action?.({ type: 'preference', field: 'notifications', value: false });
  await vi.waitFor(() => expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ roam: false, notifications: false })));
  action?.({ type: 'preference', field: 'electronPath', value: true });
  expect(bridge.configure).toHaveBeenCalledTimes(2);
  await fiber.dispose(); await ctx.fiber.dispose();
});

it('registers and disposes exact authenticated Connection routes without taking over the shared Gateway', async () => {
  const ctx = new Context(); ctx.provide('agents', { list: () => [] });
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>();
  const session = { id: SessionId('existing'), header: { id: SessionId('existing'), cwd: '/existing' } } as Session;
  // Two real identities differing only by whitespace: open-session must not normalize one into the other.
  const twin = { id: SessionId('existing  exact'), header: { id: SessionId('existing  exact'), cwd: '/existing-exact' } } as Session;
  ctx.provide('sessions', { list: () => [session, twin], get: (id: string) => [session, twin].find(item => item.id === id) } as never);
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route); return () => { routes.delete(route.path); }; } } } as never);
  let action: ((value: unknown) => void) | undefined;
  const bridge: PetBridge = { ...nativeBridge(), onAction: listener => { action = listener; }, focusHarness: vi.fn() };
  const fiber = ctx.plugin(async scope => mountPet(scope, Config({ autoStart: false }), bridge)); await fiber.await();
  expect([...routes.keys()]).toEqual(['status', 'control', 'navigation', 'locale', 'notification-state', 'notification-claim', 'notification-receipt', 'notification-snooze', 'notification-test'].map(endpoint => `/api/coopanion/${endpoint}`));
  const invoke = async (payload: unknown) => {
    const response = await routes.get('/api/coopanion/control')!.fetch(new Request('http://localhost/api/coopanion/control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'coopanion/control', payload }) }));
    return response.json();
  };
  expect((await invoke({ command: 'start', electronPath: '/untrusted' })).result.ok).toBe(false);
  expect(bridge.start).not.toHaveBeenCalled();
  const language = async (payload: unknown) => (await routes.get('/api/coopanion/locale')!.fetch(new Request('http://localhost/api/coopanion/locale', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'locale-test', method: 'coopanion/locale', payload }) }))).json();
  expect((await language({ locale: 'en', extra: true })).result.ok).toBe(false);
  expect((await language({ locale: 'en-US' })).result.ok).toBe(false);
  expect((await language({ locale: 'zh' })).result).toEqual({ ok: true, value: { locale: 'zh' } });
  expect((await language({ locale: 'en' })).result).toEqual({ ok: true, value: { locale: 'en' } });
  await routes.get('/api/coopanion/notification-state')!.fetch(new Request('http://localhost/api/coopanion/notification-state', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'legacy', method: 'coopanion/notification-state', payload: { locale: 'zh' } }) }));
  expect(await invoke({ command: 'start' })).toEqual({ type: 'server-response', rpcId: 'test', result: { ok: true, value: { phase: 'running', visible: true, desiredVisible: true, recoveryAttempt: 0, generation: 1, visibilityRevision: 2, suspended: false } } });
  expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }), expect.anything());
  const malformed = await routes.get('/api/coopanion/status')!.fetch(new Request('http://localhost/api/coopanion/status', { method: 'POST', body: '{}' }));
  expect(malformed.status).toBe(400);
  expect(bridge.update).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing' }));
  action?.({ type: 'chat', sessionId: 'existing', text: '不能静默丢弃', requestId: 'service-missing-request', clientTimeZone: 'UTC' });
  await vi.waitFor(() => expect(bridge.chatResult).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing', status: 'failed', code: 'coopanion/service-unavailable' })));
  const navigation = async () => (await routes.get('/api/coopanion/navigation')!.fetch(new Request('http://localhost/api/coopanion/navigation', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'nav', method: 'coopanion/navigation', payload: {} }) }))).json();
  action?.({ type: 'open-session', sessionId: 'unknown' }); expect((await navigation()).result.value).toBeNull();
  expect(bridge.focusHarness).not.toHaveBeenCalled();
  action?.({ type: 'open-session', sessionId: 'existing' });
  expect((await navigation()).result.value).toEqual({ sessionId: 'existing' });
  expect((await navigation()).result.value).toBeNull(); // Claimed only once.
  expect(bridge.focusHarness).toHaveBeenCalledOnce();
  expect(ctx.coopanion.hint({ title: 'hint', sessionId: 'existing  exact' })).toBe(true);
  const forwarded = vi.mocked(bridge.notify).mock.calls.at(-1)![0] as { sessionId: string };
  expect(forwarded.sessionId).toBe('existing  exact');
  action?.({ type: 'open-session', sessionId: forwarded.sessionId });
  expect((await navigation()).result.value).toEqual({ sessionId: 'existing  exact' });
  expect(bridge.update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'existing  exact' }));
  expect(bridge.focusHarness).toHaveBeenCalledTimes(2);
  await fiber.dispose(); expect(routes.size).toBe(0); await ctx.fiber.dispose();
});


it('defaults old configs to 100% and accepts only three independent text scales', async () => {
  expect(Config().textScale.get()).toBe(1);
  for (const textScale of [1, 1.25, 1.5] as const) for (const size of [90, 240]) {
    const config = Config({ textScale, size });
    expect(config.textScale.get()).toBe(textScale); expect(config.size.get()).toBe(size);
  }
  for (const textScale of [0, 1.1, 125, '1.25']) expect(() => Config({ textScale: textScale as never })).toThrow();
  const ctx = new Context(); ctx.provide('agents', { list: () => [] });
  let value: 1 | 1.25 | 1.5 = 1;
  const config = Config({ size: 90 });
  config.textScale = { get: () => value };
  const bridge = { ...nativeBridge(), configure: vi.fn() };
  const fiber = ctx.plugin(scope => mountPet(scope, config, bridge));
  try {
    await fiber.await(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
    for (const next of [1.25, 1.5, 1] as const) {
      value = next; ctx.emit('settings/document-updated', 'dsh-coopanion' as SettingsNamespace, 1);
      expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ textScale: next, size: 90 }));
    }
    expect(bridge.start).toHaveBeenCalledOnce();
  } finally { await fiber.dispose(); await ctx.fiber.dispose(); }
});

it('ignores removed rhythm preferences without enabling autonomous activity or invitations', async () => {
  expect(Config.dict).not.toHaveProperty('dailyRhythm');
  for (const dailyRhythm of [false, true]) {
    const config = Config({ dailyRhythm } as never);
    expect(config.companionship.get()).toBe('off');
    const ctx = new Context(); ctx.provide('agents', { list: () => [] });
    const bridge = nativeBridge(), fiber = ctx.plugin(scope => mountPet(scope, config, bridge));
    try {
      await fiber.await(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
      const [options] = vi.mocked(bridge.start).mock.calls[0];
      expect(options).not.toHaveProperty('dailyRhythm');
      expect(options.companionship).toBe('off');
      expect(bridge.notify).not.toHaveBeenCalled();
    } finally { await fiber.dispose(); await ctx.fiber.dispose(); }
  }
});

it('companionship defaults off, validates its enum, and joins complete hot Host configuration', async () => {
  expect(Config().companionship.get()).toBe('off');
  for (const value of [true, 1, 'loud', {}]) expect(() => Config({ companionship: value as never })).toThrow();
  const ctx = new Context(), config = Config({ autoStart: true }); ctx.provide('agents', { list: () => [] });
  let companionship: 'off' | 'quiet' | 'interactive' = 'off'; config.companionship = { get: () => companionship };
  const bridge = { ...nativeBridge(), configure: vi.fn() };
  const fiber = ctx.plugin(scope => mountPet(scope, config, bridge));
  try {
    await fiber.await(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ companionship: 'off' }), expect.anything()));
    for (const mode of ['quiet', 'interactive', 'off'] as const) { companionship = mode; ctx.emit('settings/document-updated', 'dsh-coopanion' as SettingsNamespace, 1); expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ companionship: mode })); }
  } finally { await fiber.dispose(); await ctx.fiber.dispose(); }
});


it('persists relative NPC home/range and hot-syncs the complete options', async () => {
  expect(Config().npcHome.get()).toBe(.85); expect(Config().npcRange.get()).toBe(.3);
  for (const value of [0, 1, NaN, '0.4']) expect(() => Config({ npcRange: value as never })).toThrow();
  const ctx = new Context(), config = Config({ autoStart: true, npcHome: .1, npcRange: .5 }); ctx.provide('agents', { list: () => [] });
  let home = .1; config.npcHome = { get: () => home };
  const bridge = { ...nativeBridge(), configure: vi.fn() }, fiber = ctx.plugin(scope => mountPet(scope, config, bridge));
  try {
    await fiber.await(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ npcHome: .1, npcRange: .5 }), expect.anything()));
    home = .8; ctx.emit('settings/document-updated', 'dsh-coopanion' as SettingsNamespace, 1);
    expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ npcHome: .8, npcRange: .5, roam: true }));
    expect(bridge.start).toHaveBeenCalledOnce();
  } finally { await fiber.dispose(); await ctx.fiber.dispose(); }
});
