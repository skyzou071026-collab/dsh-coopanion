import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listDiagnostics, readDiagnostics } from '../scripts/diagnostics-client.mjs';
const require = createRequire(import.meta.url), packageRoot = resolve(process.env.DSH_LIFECYCLE_PACKAGE_ROOT ?? '.');
const run = promisify(execFile);
const real = process.env.DSH_LIFECYCLE_NATIVE_REAL === '1';
const expectedRealState = process.env.DSH_LIFECYCLE_EXPECT_STATE ?? 'locked';
assert.ok(['locked', 'unlocked'].includes(expectedRealState));
const records = [], shutdowns = [];
const traceShutdown = !real && process.env.DSH_LIFECYCLE_TRACE === '1';
const lateDisplay = !real && process.env.DSH_LIFECYCLE_LATE_DISPLAY === '1';
const reportPath = real ? 'artifacts/lifecycle-startup-real.json' : lateDisplay ? 'artifacts/lifecycle-startup-late-display.json' : 'artifacts/lifecycle-startup-native.json';
for (const initialState of real ? ['system'] : ['locked', 'unknown', 'restore-locked', 'system']) {
  console.log(`Lifecycle startup case: ${initialState}`);
  const root = await mkdtemp(join(tmpdir(), 'dsh-initial-lock-'));
  const env = { ...process.env, DSH_PET_TEST_DATA_DIR: join(root, 'pet'), DSH_PET_TEST_DIAGNOSTICS_DIR: join(root, 'registry'), DSH_PET_SCREEN_LOCKED: initialState === 'restore-locked' ? '1' : '0', DSH_PET_SYSTEM_ASLEEP: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  if (real) { delete env.DSH_PET_TEST_NO_SANDBOX; delete env.DSH_PET_TEST_DEBUG_PORT; delete env.DSH_PET_TEST_INITIAL_LOCK_STATE; }
  else { env.DSH_PET_TEST_NO_SANDBOX = '1'; env.DSH_PET_TEST_DEBUG_PORT = '0'; env.DSH_PET_TEST_INITIAL_LOCK_STATE = initialState === 'restore-locked' ? 'unlocked' : initialState; }
  const child = spawn(require('electron'), [...(traceShutdown ? ['--require', resolve('tests/fixtures/lifecycle-shutdown-trace.cjs')] : []), ...(lateDisplay ? ['--require', resolve('tests/fixtures/late-display-quit.cjs')] : []), ...(real ? [] : ['--no-sandbox']), join(packageRoot, 'desktop/main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = '';
  let nativeReady = false, lateDisplayEvents = 0, originalError, shutdownError;
  const phases = [];
  child.on('message', message => {
    if (message?.type === 'ready') nativeReady = true;
    if (message?.type === 'late-display-injected') lateDisplayEvents++;
    if (message?.type === 'lifecycle-shutdown-trace' && phases.length < 64) phases.push(message);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  try {
    child.send({ type: 'init', baseline: true, options: { size: 150, companionship: 'quiet', roam: true, diagnostics: true, notifications: false }, snapshot: { mood: 'idle', active: false, sessionId: null, sessions: [], results: [] } });
    let snapshot;
    for (let attempt = 0; attempt < 80; attempt++) {
      const [endpoint] = await listDiagnostics(join(root, 'registry'));
      // The diagnostic endpoint exists before loadURL finishes. Quitting on
      // that signal alone cancels a slow first navigation and exits with error.
      if (endpoint && nativeReady) { snapshot = await readDiagnostics(endpoint); break; }
      assert.equal(child.exitCode, null, stderr); await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(snapshot, 'Initial diagnostic endpoint must become available');
    const state = snapshot.value.runtime;
    if (real && expectedRealState === 'unlocked') {
      assert.equal(state.screenLocked, false, 'A cold start on an unlocked desktop must initialize unlocked');
      assert.equal(state.suspended, false, 'The ordinary sandbox must allow NPC activity on an unlocked desktop');
      assert.equal(state.lockStateKnown, true);
      for (let attempt = 0; attempt < 30; attempt++) {
        const [endpoint] = await listDiagnostics(join(root, 'registry'));
        snapshot = await readDiagnostics(endpoint);
        if (snapshot.value.renderer?.npc?.keyboardStatus === 'available') break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(snapshot.value.renderer?.npc?.keyboardStatus, 'available', 'Unblocked lifecycle must start the real keyboard adapter');
    } else if (initialState === 'locked' || initialState === 'restore-locked' || real) {
      assert.equal(state.screenLocked, true, 'A cold start on a locked desktop must initialize locked');
      assert.equal(state.suspended, true); assert.equal(state.lockStateKnown, true);
    } else if (initialState === 'unknown') {
      assert.equal(state.lockStateKnown, false); assert.equal(state.suspended, true);
    } else {
      assert.equal(typeof state.lockStateKnown, 'boolean');
      if (!state.lockStateKnown || state.screenLocked) assert.equal(state.suspended, true);
    }
    records.push({ platform: process.platform, build: snapshot.build, controlledInitialState: real ? null : initialState, expectedRealState: real ? expectedRealState : null, normalSandbox: real, runtime: state, npc: snapshot.value.renderer?.npc });
  } catch (error) { originalError = error; }
  finally {
    const began = performance.now(); let forced = false, exitedAt, sample, sampleFile, sampleError;
    exited.then(() => { exitedAt = performance.now(); });
    // Capture the owned process before the existing kill guard. A quit event
    // alone cannot identify a native shutdown stall after JavaScript stops.
    const sampling = traceShutdown && process.platform === 'darwin' ? setTimeout(() => {
      sampleFile = `artifacts/lifecycle-shutdown-${initialState}.txt`;
      sample = mkdir('artifacts', { recursive: true }).then(() => run('/usr/bin/sample', [String(child.pid), '1', '1', '-file', resolve(sampleFile)], { timeout: 3000 }))
        .catch(error => { sampleError = String(error.message).slice(0, 600); });
    }, 1500) : undefined;
    const deadline = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
    try {
      // Windows SIGTERM forcibly terminates the main process before Chromium
      // releases its profile. Use the desktop's normal IPC quit path instead.
      console.log(`Lifecycle shutdown case: ${initialState}, ready=${nativeReady}`);
      if (child.connected) child.send({ type: 'quit' }); else child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(signal, null, stderr); assert.equal(code, 0, stderr);
      assert.ok(!stderr.includes('Lifecycle exception: '), stderr);
      if (lateDisplay) assert.ok(lateDisplayEvents > 0, 'The late native display event must actually fire');
    } catch (error) { shutdownError = error;
    } finally {
      clearTimeout(deadline); clearTimeout(sampling); await sample;
      shutdowns.push({ initialState, nativeReady, lateDisplayEvents, code: child.exitCode, signal: child.signalCode, forced, elapsedMs: Math.round((exitedAt ?? performance.now()) - began), phases,
        ...(sampleFile ? { sampleFile, ...(sampleError ? { sampleError } : {}) } : {}),
        originalError: originalError ? String(originalError) : null, shutdownError: shutdownError ? String(shutdownError) : null });
      await mkdir('artifacts', { recursive: true });
      await writeFile(reportPath, JSON.stringify({ records, shutdowns }, null, 2) + '\n');
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  if (originalError && shutdownError) throw new AggregateError([originalError, shutdownError], 'Native lifecycle assertion and cleanup failed; see ' + reportPath);
  if (originalError) throw originalError;
  if (shutdownError) throw shutdownError;
}
console.log('Native lifecycle startup passed: ' + (real ? 'ordinary sandbox, expected ' + expectedRealState : 'controlled locked/unknown and system adapter observation') + '.');
