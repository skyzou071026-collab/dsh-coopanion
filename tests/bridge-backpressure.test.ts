import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval';
import { ElectronBridge } from '../src/bridge.ts';
import { PetControls } from '../src/controls.ts';
import { NotificationBroker } from '../src/notification-broker.ts';

it('accepts queued hints under real IPC backpressure and sends each broker notice once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-backpressure-'));
  const peer = join(directory, 'peer.cjs');
  await writeFile(peer, `
const { readSync } = require('node:fs');
const notices = [];
process.on('message', message => {
  if (message.type === 'pause') process.send({ type: 'paused' }, () => {
    // The parent explicitly releases this barrier after filling the IPC queue.
    readSync(0, Buffer.alloc(1), 0, 1, null);
  });
  if (message.type === 'notice') notices.push(message.notice);
  if (message.type === 'report') process.send({ type: 'report', notices });
  if (message.type === 'quit') process.exit(0);
});
process.send({ type: 'ready' });
`);
  const child = fork(peer, { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  const bridge = new ElectronBridge();
  Object.assign(bridge as unknown as { child: ChildProcess }, { child });
  Object.assign(bridge, { nativeVisible: true, suspended: false, generation: 1, visibilityRevision: 1 });
  // Only native window startup is substituted; sends use the real child channel.
  bridge.start = async () => { bridge.emit('lifecycle', { running: true, visible: true, generation: 1, visibilityRevision: 1, suspended: false }); };
  const controls = new PetControls(bridge, () => ({ size: 150, roam: false, notifications: true, bubbleDurationMs: 12000 }));
  const broker = new NotificationBroker({ presentRole: (notice, runtime) => bridge.presentRole(notice, runtime) });
  let released = false;
  try {
    await once(child, 'message');
    await controls.command('start');
    broker.preferences({ reminders: false }); broker.runtime(controls.status());
    const paused = once(child, 'message'); child.send({ type: 'pause' });
    expect((await paused)[0]).toMatchObject({ type: 'paused' });
    expect(child.send({ type: 'padding', value: 'x'.repeat(2 * 1024 * 1024) })).toBe(false);
    const accepted = controls.hint({ title: 'queued hint' });
    const session = { id: SessionId('backpressure-source'), header: { version: 4 as const, id: SessionId('backpressure-source'), createdAt: 0, isSeeded: false, cwd: '/review' } };
    broker.consume(session, { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } });
    broker.consume(session, { type: 'approval/asked', seq: SessionSeq(1), time: 2, data: { id: ApprovalRequestId('backpressure-approval'), toolName: 'bash' } });
    broker.preferences({ notifications: true }); // A refresh must not send it again.
    const reported = once(child, 'message'); child.send({ type: 'report' });
    child.stdin!.write(Buffer.from([0]));
    released = true;
    const report = (await reported)[0] as { type: string; notices: { title: string; category?: string }[] };
    expect(report.type).toBe('report');
    expect(report.notices.filter(notice => notice.title === 'queued hint')).toHaveLength(1);
    expect.soft(accepted).toBe(true);
    expect.soft(broker.history()[0].state).toBe('role');
    expect.soft(report.notices.filter(notice => notice.category === 'approval')).toHaveLength(1);
  } finally {
    broker.dispose();
    if (!released && child.stdin?.writable) child.stdin.write(Buffer.from([0]));
    await controls.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
