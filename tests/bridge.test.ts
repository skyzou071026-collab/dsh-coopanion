import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectronBridge, type DesktopOptions } from '../src/bridge.ts';
import type { ChildProcess } from 'node:child_process';
import type { PetSnapshot } from '../src/model.ts';
import type { NotificationSnapshot } from '../src/notification-contract.ts';

it.skipIf(process.platform !== 'linux')('fails directly without a graphical environment', async () => {
  const display = process.env.DISPLAY, wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  const bridge = new ElectronBridge();
  try { await expect(bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000 })).rejects.toMatchObject({ recoverable: false, message: '桌宠需要桌面显示环境。' }); }
  finally { if (display !== undefined) process.env.DISPLAY = display; if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland; await bridge.dispose(); }
});

it.skipIf(process.platform === 'win32')('releases a process that exits by signal before the ready handshake', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-failure-'));
  const previous = process.env.WAYLAND_DISPLAY;
  process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge();
  try {
    const binary = join(folder, 'exits-before-ready');
    await writeFile(binary, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o700 });
    await expect(bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000, electronPath: binary })).rejects.toMatchObject({ recoverable: true, message: expect.stringContaining('SIGTERM') });
    await expect(bridge.dispose()).resolves.toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('classifies an invalid runtime as deterministic', async () => {
  const bridge = new ElectronBridge();
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  try {
    await expect(bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000, electronPath: '/missing/coopanion-runtime' })).rejects.toMatchObject({ recoverable: false });
  } finally {
    await bridge.dispose(); if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
  }
});

it.skipIf(process.platform === 'win32')('honors explicit native startup failure classification instead of retrying every exception', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-classification-'));
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge();
  try {
    const binary = join(folder, 'declared-failure');
    await writeFile(binary, `#!${process.execPath}\nprocess.send({type:'startup-error',error:'native deterministic failure',recoverable:false}); setInterval(()=>{},1000);\n`, { mode: 0o700 });
    await expect(bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000, electronPath: binary })).rejects.toMatchObject({ recoverable: false, message: 'native deterministic failure' });
  } finally {
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
  }
});

it.skipIf(process.platform === 'win32')('rehydrates full Host snapshots silently, initializes hidden, and isolates old process messages', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-recovery-ipc-'));
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge();
    const opts: DesktopOptions = { size: 150, roam: false, notifications: true, bubbleDurationMs: 12000 };
  const actions: unknown[] = [], states: unknown[] = [];
  bridge.onAction(action => actions.push(action)); bridge.onLifecycle(state => states.push(state));
  try {
    const binary = join(folder, 'recovery-peer');
    await writeFile(binary, `#!${process.execPath}
process.on('message', m => {
  if (m.type === 'init') process.send({type:'action',action:{type:'init-observed',frame:m,env:{visible:process.env.DSH_PET_VISIBLE,locked:process.env.DSH_PET_SCREEN_LOCKED,asleep:process.env.DSH_PET_SYSTEM_ASLEEP}}});
  if (m.type === 'notification-state') process.send({type:'action',action:{type:'requests-observed',snapshot:m.snapshot}});
  if (m.type === 'quit') process.exit(0);
}); process.send({type:'ready'});
`, { mode: 0o700 });
    opts.electronPath = binary;
    const frame = { mood: 'idle', text: '', active: false, sessionId: 'full-focus', sessions: [{ id: 'full-focus', label: 'Full focus', mood: 'idle', text: '', reply: '', unread: 1 }], results: [{ id: 'full-result', sessionId: 'full-focus', text: '全文\n' + 'long'.repeat(1000), read: false, time: 1 }] } as PetSnapshot;
    bridge.update(frame);
    const notifications: NotificationSnapshot = { protocol: 1, runtime: { phase: 'running', generation: 1, visibilityRevision: 1, visible: false, suspended: false }, interactions: [{ id: 'pending-full', sessionId: 'full-focus', nativeId: 'native-full', kind: 'approval', turn: 1, seq: 2, createdAt: 1, preview: 'still pending', state: 'open', dueAt: null, automaticReminders: 0 }] };
    bridge.notificationState(notifications);
    await bridge.start(opts);
    const old = (bridge as unknown as { child: ChildProcess }).child;
    old.emit('message', { type: 'visibility', generation: 1, visibilityRevision: 1, visible: false, suspended: true, screenLocked: true, systemAsleep: true });
    await bridge.dispose();
    bridge.update({ ...frame, text: 'latest while down' });
    const secondInit = new Promise<Record<string, any>>(resolve => { const listener = (value: any) => { if (value.type === 'init-observed' && value.env.visible === '0') { bridge.removeAction(listener); resolve(value); } }; bridge.onAction(listener); });
    await bridge.start(opts, { signal: new AbortController().signal, generation: 2, visible: false });
    const received = await secondInit;
    expect(received.env).toEqual({ visible: '0', locked: '1', asleep: '1' });
    expect(received.frame).toMatchObject({ type: 'init', baseline: true, snapshot: { sessionId: 'full-focus', text: 'latest while down', results: frame.results } });
    const count = actions.length, stateCount = states.length;
    old.emit('message', { type: 'action', action: { type: 'chat', text: 'must not replay' } });
    old.emit('message', { type: 'visibility', generation: 1, visibilityRevision: 999, visible: true });
    old.emit('exit', 1, null);
    expect(actions).toHaveLength(count); expect(states).toHaveLength(stateCount);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(actions).toContainEqual({ type: 'requests-observed', snapshot: notifications });
  } finally {
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
  }
});

it.skipIf(process.platform === 'win32')('aborts a live startup and confirms its process exits without waiting for the handshake timeout', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-cancel-'));
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge(), controller = new AbortController();
  try {
    const binary = join(folder, 'waits-for-ready');
    await writeFile(binary, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    const startup = bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000, electronPath: binary }, { signal: controller.signal, generation: 9 });
    const assertion = expect(startup).rejects.toThrow('启动已取消'); controller.abort();
    await assertion; await expect(bridge.dispose()).resolves.toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('forwards exact chat receipts across the child-process bridge', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-chat-ipc-'));
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge();
  try {
    const binary = join(folder, 'chat-peer');
    await writeFile(binary, `#!${process.execPath}\nprocess.on('message', m => { if (m.type === 'chat-result') process.send({type:'action',action:m}); if (m.type === 'quit') process.exit(0); }); process.send({type:'ready'});\n`, { mode: 0o700 });
    await bridge.start({ size: 150, roam: false, notifications: false, bubbleDurationMs: 12000, electronPath: binary });
    const receipt = { type: 'chat-result' as const, sessionId: 'fixed-full-session', requestId: 'full-client-request-01', status: 'accepted' as const };
    const delivered = new Promise(resolve => bridge.onAction(resolve)); bridge.chatResult(receipt);
    await expect(delivered).resolves.toEqual(receipt);
  } finally {
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('ready sends the latest complete preferences changed during startup', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-latest-options-'));
  const previous = process.env.WAYLAND_DISPLAY; process.env.WAYLAND_DISPLAY = 'test-only';
  const bridge = new ElectronBridge();
  try {
    const binary = join(folder, 'delayed-peer');
    await writeFile(binary, `#!${process.execPath}
process.on('message', m => {
  if (m.type === 'configure') process.send({type:'ready'});
  if (m.type === 'init') process.send({type:'action',action:{type:'latest-init',options:m.options}});
  if (m.type === 'quit') process.exit(0);
});
`, { mode: 0o700 });
    const options: DesktopOptions = { size: 90, textScale: 1, companionship: 'off', roam: true, notifications: true, bubbleDurationMs: 12000, locale: 'zh', electronPath: binary };
    const delivered = new Promise<any>(resolve => bridge.onAction(resolve));
    const start = bridge.start(options);
    bridge.configure({ ...options, size: 240, textScale: 1.5, companionship: 'interactive', locale: undefined });
    await start;
    expect(await delivered).toEqual({ type: 'latest-init', options: { ...options, size: 240, textScale: 1.5, companionship: 'interactive', locale: null } });
  } finally {
    await bridge.dispose(); await rm(folder, { recursive: true, force: true });
    if (previous === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previous;
  }
});

// Platform-neutral fake child: the production failure modes are IPC-channel
// state, not POSIX shebang handling, so Windows CI must exercise them too.
it('reports native IPC acceptance per call instead of unconditional success', () => {
  const bridge = new ElectronBridge();
  const notice = { title: 'hi', body: '', sessionId: '', kind: 'message' as const };
  const runtime = { phase: 'running' as const, generation: 3, visibilityRevision: 4, visible: true, suspended: false };
  const sent: unknown[] = [];
  Object.assign(bridge as unknown as Record<string, unknown>, {
    child: { connected: true, send: (message: object) => { sent.push(message); return true; } },
    nativeVisible: true, suspended: false, generation: 3, visibilityRevision: 4,
  });
  expect(bridge.notify(notice, runtime)).toBe(true);
  expect(sent.at(-1)).toMatchObject({ type: 'notice', notice, generation: 3, visibilityRevision: 4 });
  expect(bridge.notify(notice, { ...runtime, generation: 2 })).toBe(false);
  expect(bridge.notify(notice, { ...runtime, visibilityRevision: 5 })).toBe(false);
  expect(bridge.notify(notice, { ...runtime, visible: false })).toBe(false);
  Object.assign(bridge as unknown as Record<string, unknown>, { nativeVisible: false });
  expect(bridge.notify(notice, runtime)).toBe(false);
  Object.assign(bridge as unknown as Record<string, unknown>, { nativeVisible: true, suspended: true });
  expect(bridge.notify(notice, runtime)).toBe(false);
  Object.assign(bridge as unknown as Record<string, unknown>, { suspended: false, child: { connected: false } });
  expect(bridge.notify(notice, runtime)).toBe(false);
  Object.assign(bridge as unknown as Record<string, unknown>, { child: { connected: true, send: () => false } });
  expect(bridge.notify(notice, runtime)).toBe(true);
});
it('reports an asynchronous send failure without resending an accepted notice', () => {
  const bridge = new ElectronBridge();
  let complete!: (error: Error | null) => void, calls = 0;
  const failures: Error[] = []; bridge.on('failure', error => failures.push(error));
  Object.assign(bridge, { child: { connected: true, send: (_message: object, callback: typeof complete) => { complete = callback; calls++; return false; } } });
  expect(bridge.notify({ title: 'queued', body: '', sessionId: '' })).toBe(true);
  const failure = new Error('asynchronous IPC failure'); complete(failure);
  expect(failures).toEqual([failure]); expect(calls).toBe(1);
});
it('rejects a notice while closing or when the IPC channel throws', () => {
  const bridge = new ElectronBridge();
  const notice = { title: 'hi', body: '', sessionId: '', kind: 'message' as const };
  Object.assign(bridge as unknown as Record<string, unknown>, {
    child: { connected: true, send: () => true }, nativeVisible: true, suspended: false, generation: 3, visibilityRevision: 4, closing: true,
  });
  expect(bridge.notify(notice)).toBe(false);
  Object.assign(bridge as unknown as Record<string, unknown>, { closing: false, child: { connected: true, send: () => { throw new Error('ipc gone'); } } });
  expect(bridge.notify(notice)).toBe(false);
});
