import { it, expect } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Diagnostics } from '../src/diagnostics.ts';
import { CompanionStore } from '../src/companion-store.ts';
import { listDiagnostics, readDiagnostics, sanitizeSnapshot } from '../scripts/diagnostics-client.mjs';
import { createDiagnosticCounters } from '../web/diagnostics.js';

const fake = () => ({
  runtime: { generation: 1, visible: true, suspended: false },
  store: { initialized: false, writable: false, failed: false, bytes: 0, revision: 0, recentCount: 0, characterCount: 0, invitations: 0, pending: 0 },
  renderer: { mode: 'interactive', activity: 'idle', invitation: 'none', mood: 'idle', careUnavailable: false, hidden: false, hour: 12,
    queues: { carePending: 0, pendingInteractions: 0, composerSessions: 0, chatTimers: 0, snoozing: 0, shownResults: 0, acknowledgedResults: 0 },
    counts: { routines: { observe: 0, play: 0, rest: 0, greeting: 0 }, invitationsShown: 0, invitationsExpired: 0, invitationsAccepted: 0, invitationsLater: 0, invitationsQuiet: 0 }, heapBytes: 1, nodes: 1 },
});
const build = { schema: 1, commit: 'a'.repeat(40), dirty: false, productDigest: 'b'.repeat(64) };
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-diagnostics-'));
  const registry = join(root, 'registry');
  let reads = 0;
  const api = new Diagnostics({ registry, profile: root, version: '0.4.10', build, read: async () => { reads++; return fake(); } });
  try { await run({ api, registry, root, reads: () => reads }); }
  finally { await api.close(); await rm(root, { recursive: true, force: true }); }
}
function rawRead(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: endpoint.socketPath, path: '/snapshot', headers: { Authorization: 'Bearer ' + endpoint.token }, ...options }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    req.once('error', reject); req.end();
  });
}
it('publishes no endpoint by default, authenticates read-only access and withdraws on disable', async () => fixture(async f => {
  expect(await listDiagnostics(f.registry)).toEqual([]);
  expect(f.reads()).toBe(0);
  await f.api.configure(true);
  const [endpoint] = await listDiagnostics(f.registry);
  expect(await rawRead(endpoint, { method: 'POST' })).toBe(405);
  expect(await rawRead(endpoint, { headers: { Authorization: 'Bearer wrong' } })).toBe(403);
  expect(await rawRead(endpoint, { headers: { Authorization: 'Bearer ' + endpoint.token, Origin: 'null' } })).toBe(403);
  expect(f.reads()).toBe(0);
  expect((await readDiagnostics(endpoint)).value.renderer.mode).toBe('interactive');
  expect(f.reads()).toBe(1);
  if (process.platform !== 'win32') {
    expect((await stat(f.registry)).mode & 0o077).toBe(0);
    expect((await stat(endpoint.socketPath)).mode & 0o077).toBe(0);
  }
  await f.api.configure(false);
  expect(await listDiagnostics(f.registry)).toEqual([]);
  await expect(readDiagnostics(endpoint, 50)).rejects.toThrow();
}));
it('collapses rapid toggles to the latest intent and changes sessions without retaining old descriptors', async () => fixture(async f => {
  await Promise.all([f.api.configure(true), f.api.configure(false), f.api.configure(true)]);
  const [before] = await listDiagnostics(f.registry);
  expect((await readdir(f.registry)).length).toBe(1);
  await f.api.configure(false); await f.api.configure(true);
  const [after] = await listDiagnostics(f.registry);
  expect(after.instance).toBe(before.instance); expect(after.session).not.toBe(before.session);
  expect((await readdir(f.registry)).length).toBe(1);
}));
it('diagnostic reads never initialize or mutate a companion archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inspect-')), directory = join(root, 'care');
  const store = new CompanionStore(directory);
  try {
    expect(store.inspect()).toMatchObject({ initialized: false, pending: 0, bytes: 0 });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.request({ type: 'read', characterId: 'whale' });
    const before = store.inspect();
    expect(before.pending).toBe(0); expect(before.recentCount).toBe(0);
    expect(store.inspect()).toEqual(before);
    await expect(readFile(join(directory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
it('drops unrecognized text and credentials and rejects a wrong runtime identity', async () => fixture(async f => {
  await f.api.configure(true); const [endpoint] = await listDiagnostics(f.registry);
  const snapshot = await readDiagnostics(endpoint);
  snapshot.value.renderer.npc = { phase: 'yield', reason: 'unknown', keyboard: 'unknown', targetValid: true, compact: true, keyboardBackend: 'x11', keyboardStatus: 'unsupported-session', text: 'private keyboard content' };
  snapshot.value.chat = 'private message'; snapshot.value.renderer.text = 'private draft'; snapshot.token = endpoint.token;
  const clean = sanitizeSnapshot(snapshot, endpoint);
  expect(clean.value.renderer.npc).toEqual({ phase: 'yield', reason: 'unknown', keyboard: 'unknown', targetValid: true, compact: true, keyboardBackend: 'x11', keyboardStatus: 'unsupported-session' });
  expect(JSON.stringify(clean)).not.toContain('private');
  snapshot.value.renderer.npc.keyboardStatus = 'private';
  expect(() => sanitizeSnapshot(snapshot, endpoint)).toThrow('keyboard status');
  expect(JSON.stringify(clean)).not.toContain(endpoint.token);
  expect(() => sanitizeSnapshot({ ...snapshot, session: '0'.repeat(32) }, endpoint)).toThrow('identity');
}));
it('keeps activity counters fixed-size and clears them when diagnostics are disabled', () => {
  const counters = createDiagnosticCounters();
  counters.activity('play'); expect(counters.snapshot()).toBeNull();
  counters.configure(true); counters.activity('play'); counters.activity('play'); counters.activity('idle'); counters.activity('rest');
  counters.event('invitationsShown'); counters.event('private user text');
  expect(counters.snapshot().routines).toEqual({ observe: 0, play: 1, rest: 1, greeting: 0 });
  expect(counters.snapshot().invitationsShown).toBe(1);
  counters.configure(false); counters.configure(true);
  expect(counters.snapshot().invitationsShown).toBe(0);
});

it('keeps only fixed lifecycle state and counters, including events between reads', async () => fixture(async f => {
  await f.api.configure(true); const [endpoint] = await listDiagnostics(f.registry);
  const snapshot = await readDiagnostics(endpoint);
  snapshot.value.runtime = { ...snapshot.value.runtime, screenLocked: true, systemAsleep: false, lockStateKnown: true,
    lifecycle: { locks: 2, unlocks: 1, suspends: 1, resumes: 1, text: 'private' } };
  expect(sanitizeSnapshot(snapshot, endpoint).value.runtime).toEqual({ generation: 1, visible: true, suspended: false,
    screenLocked: true, systemAsleep: false, lockStateKnown: true, lifecycle: { locks: 2, unlocks: 1, suspends: 1, resumes: 1 } });
  snapshot.value.runtime.screenLocked = 'private';
  expect(() => sanitizeSnapshot(snapshot, endpoint)).toThrow('lifecycle');
  snapshot.value.runtime.screenLocked = true; snapshot.value.runtime.lifecycle.resumes = -1;
  expect(() => sanitizeSnapshot(snapshot, endpoint)).toThrow('number');
}));
it.skipIf(process.platform === 'win32')('honors a wall deadline even while the diagnostic endpoint is unavailable', async () => fixture(async f => {
  const output = join(f.root, 'deadline');
  const deadline = new Date(Date.now() + 1500).toISOString();
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/sample-companion.mjs', import.meta.url)),
    '--registry', f.registry, '--output', output, '--seconds', '600', '--interval', '1', '--until', deadline], { timeout: 10000 });
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  expect(summary).toMatchObject({ reason: 'deadline', status: 'recorded', samples: 0, fullTwoHourObservation: false });
  expect(Date.parse(summary.endedAt)).toBeGreaterThanOrEqual(Date.parse(deadline));
  const metadata = JSON.parse(await readFile(join(output, 'metadata.json'), 'utf8'));
  expect(metadata.wallDeadline).toBe(deadline);
}), 15000);
it.skipIf(process.platform === 'win32')('a calendar deadline never grants continuous-resource acceptance', async () => fixture(async f => {
  await f.api.configure(true);
  const output = join(f.root, 'live-deadline');
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/sample-companion.mjs', import.meta.url)),
    '--registry', f.registry, '--output', output, '--seconds', '7200', '--interval', '1', '--window', '1800',
    '--until', new Date(Date.now() + 2500).toISOString()], { timeout: 10000 });
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  expect(summary).toMatchObject({ reason: 'deadline', status: 'recorded', fullTwoHourObservation: false });
  expect(summary.samples).toBeGreaterThan(0);
}), 15000);
