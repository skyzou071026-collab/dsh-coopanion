import { expect, it, vi } from 'vitest';
import { PetControls, NativeStartError, type NativeLifecycle, type StartLifetime } from '../src/controls.ts';
import type { DesktopOptions, PetBridge } from '../src/bridge.ts';

const options: DesktopOptions = { size: 150, roam: true, notifications: true, bubbleDurationMs: 12000 };
function fixture(limits = {}, overrides: Partial<DesktopOptions> = {}) {
  let lifecycle: (state: NativeLifecycle) => void = () => {}, generation = 0, revision = 0;
  const bridge: PetBridge = {
    start: vi.fn(async (_options: DesktopOptions, lifetime?: StartLifetime) => { generation = lifetime?.generation ?? 0; revision = 1; lifecycle({ running: true, visible: lifetime?.visible !== false, generation, visibilityRevision: revision }); }),
    dispose: vi.fn(async () => {}), update: vi.fn(), notify: vi.fn(() => true),
    onAction: vi.fn(), removeAction: vi.fn(), configure: vi.fn(),
    control: vi.fn(command => { if (command !== 'characters') lifecycle({ running: true, visible: command !== 'hide', generation, visibilityRevision: ++revision }); }),
    onLifecycle: listener => { lifecycle = listener; }, removeLifecycle: vi.fn(),
  };
  return { bridge, controls: new PetControls(bridge, () => ({ ...options, ...overrides }), limits), lifecycle: (value: NativeLifecycle) => lifecycle(value) };
}
it('serializes concurrent starts, recovers after native close, and shows a hidden pet without spawning another', async () => {
  const { controls, bridge, lifecycle } = fixture();
  await Promise.all([controls.command('start'), controls.command('start')]);
  expect(bridge.start).toHaveBeenCalledOnce();
  await controls.command('hide'); expect(controls.status()).toMatchObject({ phase: 'running', visible: false, generation: 1 });
  await controls.command('show'); expect(bridge.start).toHaveBeenCalledOnce();
  lifecycle({ running: false, visible: false, generation: 1, visibilityRevision: 10 }); expect(controls.status().phase).toBe('stopped');
  await controls.command('start'); expect(bridge.start).toHaveBeenCalledTimes(2); expect(controls.status().generation).toBe(2);
  await controls.command('restart'); expect(bridge.dispose).toHaveBeenCalledOnce(); expect(bridge.start).toHaveBeenCalledTimes(3);
  await controls.dispose(); await expect(controls.command('start')).rejects.toThrow('停用');
});

for (const action of ['stop', 'dispose'] as const) it(`${action} cancels waiting recovery and cannot be revived by late events`, async () => {
  vi.useFakeTimers();
  const { controls, bridge, lifecycle } = fixture();
  try {
    await controls.command('start');
    lifecycle({ running: false, visible: false, generation: 1, visibilityRevision: 100, unexpected: true });
    await vi.advanceTimersByTimeAsync(0); expect(controls.status().phase).toBe('recovering');
    if (action === 'stop') await controls.command('stop'); else await controls.dispose();
    lifecycle({ running: true, visible: true, generation: 1, visibilityRevision: 101 });
    await vi.advanceTimersByTimeAsync(120000);
    expect(bridge.start).toHaveBeenCalledOnce(); expect(controls.status().phase).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  } finally { await controls.dispose(); vi.useRealTimers(); }
});

it('preserves hidden intent across recovery and resets the budget only after an uninterrupted stable interval', async () => {
  vi.useFakeTimers();
  const { controls, bridge, lifecycle } = fixture();
  const exit = () => lifecycle({ running: false, visible: false, generation: controls.status().generation, visibilityRevision: 100, unexpected: true });
  try {
    await controls.command('start'); await controls.command('hide');
    exit(); await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(bridge.start).mock.calls[1]![1]).toMatchObject({ generation: 2, visible: false });
    expect(controls.status()).toMatchObject({ phase: 'running', desiredVisible: false, visible: false, recoveryAttempt: 1 });
    lifecycle({ running: true, visible: true, generation: 1, visibilityRevision: 101 });
    expect(controls.status().visible).toBe(false);
    await vi.advanceTimersByTimeAsync(59999); expect(controls.status().recoveryAttempt).toBe(1);
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 50, suspended: true });
    await vi.advanceTimersByTimeAsync(60000); expect(controls.status().recoveryAttempt).toBe(1);
    lifecycle({ running: true, visible: false, generation: 2, visibilityRevision: 51, suspended: false });
    await vi.advanceTimersByTimeAsync(59999); expect(controls.status().recoveryAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(controls.status().recoveryAttempt).toBe(0);
    exit(); await vi.advanceTimersByTimeAsync(1000); expect(controls.status().recoveryAttempt).toBe(1);
  } finally { await controls.dispose(); vi.useRealTimers(); }
});

it('cancels an automatic startup on stop and prevents queued starts after a stop request', async () => {
  vi.useFakeTimers();
  const { controls, bridge, lifecycle } = fixture(); let finish!: () => void, signal!: AbortSignal;
  try {
    await controls.command('start');
    vi.mocked(bridge.start).mockImplementationOnce((_options, life) => { signal = life!.signal; return new Promise(resolve => { finish = resolve; }); });
    lifecycle({ running: false, visible: false, generation: 1, visibilityRevision: 100, unexpected: true });
    await vi.advanceTimersByTimeAsync(1000); expect(controls.status().phase).toBe('starting');
    const stop = controls.command('stop'); expect(signal.aborted).toBe(true); await stop;
    finish(); lifecycle({ running: true, visible: true, generation: 2, visibilityRevision: 100 });
    await vi.advanceTimersByTimeAsync(120000); expect(controls.status().phase).toBe('stopped');
    const queued = controls.command('start'); const cancel = controls.command('stop'); await Promise.all([queued, cancel]);
    expect(bridge.start).toHaveBeenCalledTimes(2);
  } finally { await controls.dispose(); vi.useRealTimers(); }
});

it('does not retry unknown errors or failed cleanup and retains bounded diagnostics for manual recovery', async () => {
  vi.useFakeTimers();
  const { controls, bridge } = fixture({ cleanupTimeoutMs: 10 });
  try {
    vi.mocked(bridge.start).mockRejectedValueOnce(new Error('unknown failure'));
    await controls.command('start'); await vi.advanceTimersByTimeAsync(14000); expect(bridge.start).toHaveBeenCalledOnce();
    vi.mocked(bridge.start).mockRejectedValueOnce(new NativeStartError('crash'.repeat(400), true));
    vi.mocked(bridge.dispose).mockRejectedValueOnce(new Error('cleanup unconfirmed'));
    expect((await controls.command('restart')).phase).toBe('error');
    // The failed restart cleanup never admits another process.
    expect(bridge.start).toHaveBeenCalledOnce();
    const start = controls.command('start'); await vi.advanceTimersByTimeAsync(0); await start;
    expect(controls.status().error!.length).toBeLessThanOrEqual(600);
    expect(controls.status().phase).toBe('recovering');
    await controls.command('stop'); await vi.advanceTimersByTimeAsync(14000); expect(bridge.start).toHaveBeenCalledTimes(2);
  } finally { await controls.dispose(); vi.useRealTimers(); }
});

it('keeps cleanup timeout terminal even for an explicitly recoverable startup error', async () => {
  vi.useFakeTimers();
  const { controls, bridge } = fixture({ cleanupTimeoutMs: 10 });
  try {
    vi.mocked(bridge.start).mockRejectedValue(new NativeStartError('temporary', true));
    vi.mocked(bridge.dispose).mockImplementation(() => new Promise(() => {}));
    const starting = controls.command('start'); await vi.advanceTimersByTimeAsync(10); await starting;
    expect(controls.status()).toMatchObject({ phase: 'error', recoveryAttempt: 0 });
    await vi.advanceTimersByTimeAsync(14000); expect(bridge.start).toHaveBeenCalledOnce();
  } finally { const disposing = controls.dispose(); await vi.advanceTimersByTimeAsync(10); await disposing; vi.useRealTimers(); }
});

it('counts repeated successful launches that crash before stability toward the same three-attempt budget', async () => {
  vi.useFakeTimers();
  const { controls, bridge, lifecycle } = fixture({ retryDelaysMs: [10, 30, 100], stableMs: 600 });
  try {
    await controls.command('start');
    for (const [index, delay] of [10, 30, 100].entries()) {
      lifecycle({ running: false, visible: false, generation: controls.status().generation, visibilityRevision: 100, unexpected: true });
      await vi.advanceTimersByTimeAsync(delay);
      expect(controls.status()).toMatchObject({ phase: 'running', recoveryAttempt: index + 1 });
      await vi.advanceTimersByTimeAsync(599);
    }
    lifecycle({ running: false, visible: false, generation: controls.status().generation, visibilityRevision: 100, unexpected: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(controls.status()).toMatchObject({ phase: 'error', recoveryAttempt: 3 }); expect(bridge.start).toHaveBeenCalledTimes(4);
  } finally { await controls.dispose(); vi.useRealTimers(); }
});

it('retains a strictly bounded diagnostic even when both startup and cleanup errors are huge', async () => {
  const { controls, bridge } = fixture();
  vi.mocked(bridge.start).mockRejectedValue(new NativeStartError('start'.repeat(1000), true));
  vi.mocked(bridge.dispose).mockRejectedValue(new Error('cleanup'.repeat(1000)));
  try {
    await controls.command('start');
    expect(controls.status().phase).toBe('error'); expect(controls.status().error!.length).toBeLessThanOrEqual(600);
    expect(controls.status().error).toContain('清理失败');
  } finally { await controls.dispose(); }
});

it('recovers at 1, 3 and 10 seconds, exhausts its budget and allows manual restart', async () => {
  vi.useFakeTimers();
  const { controls, bridge, lifecycle } = fixture();
  try {
    await controls.command('start');
    vi.mocked(bridge.start).mockRejectedValue(new NativeStartError('temporary crash', true));
    lifecycle({ running: false, visible: false, generation: 1, visibilityRevision: 100, unexpected: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.status()).toMatchObject({ phase: 'recovering', recoveryAttempt: 1 });
    for (const [index, delay] of [1000, 3000, 10000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(bridge.start).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1); expect(bridge.start).toHaveBeenCalledTimes(index + 2);
    }
    expect(controls.status()).toMatchObject({ phase: 'error', recoveryAttempt: 3 });
    await vi.advanceTimersByTimeAsync(60000); expect(bridge.start).toHaveBeenCalledTimes(4);
    vi.mocked(bridge.start).mockResolvedValue(); await controls.command('restart');
    expect(controls.status()).toMatchObject({ phase: 'running', recoveryAttempt: 0 });
  } finally { await controls.dispose(); vi.useRealTimers(); }
});
it('keeps launch failures retryable and can launch the character manager from a stopped process', async () => {
  const { controls, bridge } = fixture();
  vi.mocked(bridge.start).mockRejectedValueOnce(new Error('runtime missing'));
  expect(await controls.command('start')).toMatchObject({ phase: 'error', visible: false, error: 'runtime missing' });
  expect((await controls.command('characters')).phase).toBe('running');
  expect(bridge.control).toHaveBeenLastCalledWith('characters');
  controls.configure(); expect(bridge.configure).toHaveBeenCalledWith(options);
  await controls.dispose();
});
it('publishes only acknowledged visibility and rejects old generations or reused native revisions', async () => {
  const { controls, bridge, lifecycle } = fixture();
  const states: ReturnType<PetControls['status']>[] = []; const detach = controls.onState(state => states.push(state));
  vi.mocked(bridge.start).mockImplementationOnce(async () => {});
  vi.mocked(bridge.control!).mockImplementation(() => {});
  await controls.command('start'); expect(controls.status()).toMatchObject({ phase: 'running', visible: false, visibilityRevision: 0 });
  lifecycle({ running: true, visible: true, generation: 0, visibilityRevision: 1 }); expect(controls.status().visible).toBe(false);
  lifecycle({ running: true, visible: true, generation: 1, visibilityRevision: 1 }); expect(controls.status().visible).toBe(true);
  await controls.command('hide'); expect(controls.status().visible).toBe(true);
  lifecycle({ running: true, visible: false, generation: 1, visibilityRevision: 1 }); expect(controls.status().visible).toBe(true);
  lifecycle({ running: true, visible: false, generation: 1, visibilityRevision: 2 }); expect(controls.status().visible).toBe(false);
  lifecycle({ running: true, visible: false, generation: 1, visibilityRevision: 2, suspended: true }); expect(controls.status().suspended).toBe(true);
  detach(); await controls.dispose(); expect(states.some(s => s.phase === 'starting')).toBe(true);
});
it('stop cancels a pending launch immediately and a late launch completion cannot revive the old generation', async () => {
  const { controls, bridge } = fixture(); let finish!: () => void, signal!: AbortSignal;
  vi.mocked(bridge.start).mockImplementationOnce((_options, lifetime?: StartLifetime) => { signal = lifetime!.signal; return new Promise<void>(resolve => { finish = resolve; }); });
  const start = controls.command('start'); await Promise.resolve();
  const stop = controls.command('stop'); expect(signal.aborted).toBe(true);
  await start; expect((await stop).phase).toBe('stopped');
  finish(); await Promise.resolve(); expect(controls.status().phase).toBe('stopped');
  await controls.command('start'); expect(controls.status().generation).toBe(2);
  await controls.dispose();
});
it('contains cleanup failures and bounds hanging startup and cleanup without rejecting Harness disposal', async () => {
  vi.useFakeTimers();
  try {
    const { controls, bridge } = fixture({ startTimeoutMs: 100, cleanupTimeoutMs: 20 });
    vi.mocked(bridge.start).mockImplementation(() => new Promise(() => {}));
    vi.mocked(bridge.dispose).mockImplementation(() => new Promise(() => {}));
    const start = controls.command('start'); await vi.advanceTimersByTimeAsync(120);
    expect(await start).toMatchObject({ phase: 'error', visible: false });
    expect(controls.status().error).toContain('启动超时'); expect(controls.status().error).toContain('清理超时');
    const dispose = controls.dispose(); await vi.advanceTimersByTimeAsync(20); await dispose;
    expect(controls.status().error).toContain('清理超时');
    expect(bridge.removeLifecycle).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('unload aborts startup, detaches listeners and isolates broken state observers', async () => {
  const { controls, bridge } = fixture(); let signal!: AbortSignal;
  controls.onState(() => { if (controls.status().phase === 'starting') throw new Error('view gone'); });
  vi.mocked(bridge.start).mockImplementationOnce((_options, lifetime?: StartLifetime) => { signal = lifetime!.signal; return new Promise(() => {}); });
  const start = controls.command('start'); await Promise.resolve();
  const dispose = controls.dispose(); expect(signal.aborted).toBe(true);
  await Promise.all([start, dispose]); expect(controls.status().phase).toBe('stopped');
  expect(bridge.removeLifecycle).toHaveBeenCalledOnce();
});
it('delivers host hints only while the pet is running, visible and awake', async () => {
  const { controls, bridge, lifecycle } = fixture();
  expect(controls.hint({ title: '电话接通了' })).toBe(false);
  await controls.command('start');
  expect(controls.hint({ title: '电话接通了', body: '挂件正在听你说话', sessionId: 'session-1' })).toBe(true);
  expect(bridge.notify).toHaveBeenCalledWith(
    { title: '电话接通了', body: '挂件正在听你说话', sessionId: 'session-1', kind: 'message' },
    expect.objectContaining({ phase: 'running', visible: true, generation: 1, visibilityRevision: 2, suspended: false }),
  );
  lifecycle({ running: true, visible: true, generation: 1, visibilityRevision: 2, suspended: true });
  expect(controls.hint({ title: '游戏模式' })).toBe(false);
  lifecycle({ running: true, visible: false, generation: 1, visibilityRevision: 3 });
  expect(controls.hint({ title: '游戏模式' })).toBe(false);
  await controls.command('hide'); expect(controls.hint({ title: '游戏模式' })).toBe(false);
  await controls.dispose(); expect(controls.hint({ title: '游戏模式' })).toBe(false);
  expect(bridge.notify).toHaveBeenCalledOnce();
});
it('honours the notices preference and bounds hint text', async () => {
  const off = fixture({}, { notifications: false });
  await off.controls.command('start');
  expect(off.controls.hint({ title: '电话接通了' })).toBe(false);
  expect(off.bridge.notify).not.toHaveBeenCalled();
  await off.controls.dispose();
  const { controls, bridge } = fixture();
  await controls.command('start');
  expect(controls.hint({ title: '  ', body: '只有正文' })).toBe(false);
  expect(controls.hint({ title: 'T'.repeat(300), body: 'B'.repeat(3000) })).toBe(true);
  const notice = vi.mocked(bridge.notify).mock.calls[0]![0] as { title: string; body: string; kind: string };
  expect(notice.kind).toBe('message');
  expect(notice.title).toHaveLength(256); expect(notice.body).toHaveLength(2048);
  expect(bridge.notify).toHaveBeenCalledOnce();
  await controls.dispose();
});
it('passes a valid session id through verbatim and rejects invalid identities', async () => {
  const { controls, bridge } = fixture();
  await controls.command('start');
  const exact = 'hint-source  exact'; // Two spaces: a distinct session id, not display copy.
  expect(controls.hint({ title: 'hi', sessionId: exact })).toBe(true);
  expect(vi.mocked(bridge.notify).mock.calls[0]![0]).toMatchObject({ sessionId: exact });
  for (const sessionId of ['', '   ', 42, 'x'.repeat(2049)]) {
    expect(controls.hint({ title: 'hi', sessionId: sessionId as string })).toBe(false);
  }
  expect(controls.hint({ title: 'no session' })).toBe(true);
  expect(vi.mocked(bridge.notify).mock.calls.at(-1)![0]).toMatchObject({ sessionId: '' });
  expect(bridge.notify).toHaveBeenCalledTimes(2);
  await controls.dispose();
});
it('reports bridge acceptance instead of assuming IPC delivery', async () => {
  const { controls, bridge } = fixture();
  await controls.command('start');
  vi.mocked(bridge.notify).mockReturnValueOnce(false);
  expect(controls.hint({ title: '电话接通了' })).toBe(false);
  expect(controls.hint({ title: '电话接通了' })).toBe(true);
  await controls.dispose();
});
