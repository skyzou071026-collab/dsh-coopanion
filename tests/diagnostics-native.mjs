import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
import { petClick } from './helpers/native-pointer.mjs';
import { listDiagnostics, readDiagnostics } from '../scripts/diagnostics-client.mjs';
const require = createRequire(import.meta.url), root = await mkdtemp(join(tmpdir(), 'dsh-diag-native-'));
const registry = join(root, 'registry');
let app;
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', resolve('desktop/main.cjs')],
    env: { ...process.env, DSH_PET_TEST_DATA_DIR: join(root, 'pet'), DSH_PET_TEST_DIAGNOSTICS_DIR: registry, DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_DEBUG_PORT: '0' } });
  const page = await app.firstWindow(); await page.waitForSelector('#pet[data-mode]');
  const send = value => app.evaluate((_, value) => process.emit('message', value), value);
  const options = { size: 180, roam: true, companionship: 'interactive', locale: 'zh', diagnostics: false, notifications: true };
  const snapshot = { mood: 'idle', active: false, sessionId: 'diag-session', sessions: [{ id: 'diag-session', mood: 'idle', active: false, chatAvailable: true }], results: [] };
  await send({ type: 'init', baseline: true, options, snapshot }); await page.waitForSelector('#pet[data-host-ready=true]');
  assert.deepEqual(await listDiagnostics(registry), []);
  await petClick(page, {}, true);
  await page.locator('#message').fill('diagnostic private draft');
  await page.locator('#message').evaluate(n => n.setSelectionRange(2, 8));
  await send({ type: 'configure', options: { ...options, diagnostics: true } });
  let endpoint;
  for (let i = 0; i < 50; i++) { [endpoint] = await listDiagnostics(registry); if (endpoint) break; await pause(100); }
  assert.ok(endpoint);
  const first = await readDiagnostics(endpoint);
  assert.ok(first.value.renderer); assert.equal(first.version, require('../package.json').version);
  assert.equal(first.value.renderer.queues.carePending, 0);
  assert.ok(!JSON.stringify(first).includes('diagnostic private draft'));
  assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n.selectionStart, n.selectionEnd]), ['diagnostic private draft', 2, 8]);
  assert.deepEqual(first.value.runtime.lifecycle, { locks: 0, unlocks: 0, suspends: 0, resumes: 0 });
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); powerMonitor.emit('suspend'); });
  assert.deepEqual((await readDiagnostics(endpoint)).value.runtime, { generation: 1, visible: true, suspended: true,
    screenLocked: true, systemAsleep: true, lockStateKnown: true, lifecycle: { locks: 1, unlocks: 0, suspends: 1, resumes: 0 } });
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); powerMonitor.emit('unlock-screen'); });
  const resumed = (await readDiagnostics(endpoint)).value.runtime;
  assert.equal(resumed.suspended, false); assert.equal(resumed.screenLocked, false); assert.equal(resumed.systemAsleep, false);
  assert.deepEqual(resumed.lifecycle, { locks: 1, unlocks: 1, suspends: 1, resumes: 1 });
  const sampleOutput = join(root, 'passive-sampler');
  const collector = spawn(process.execPath, [resolve('scripts/sample-companion.mjs'), '--registry', registry, '--output', sampleOutput, '--seconds', '8', '--interval', '1', '--window', '10'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collectorExit = once(collector, 'exit');
  let collectorLog = '';
  collector.stdout.on('data', chunk => { collectorLog = (collectorLog + chunk).slice(-8000); });
  collector.stderr.on('data', chunk => { collectorLog = (collectorLog + chunk).slice(-8000); });
  await pause(2200);
  await send({ type: 'configure', options });
  for (let i = 0; i < 50 && (await listDiagnostics(registry)).length; i++) await pause(50);
  await pause(1500);
  await send({ type: 'configure', options: { ...options, diagnostics: true } });
  for (let i = 0; i < 50; i++) { [endpoint] = await listDiagnostics(registry); if (endpoint) break; await pause(50); }
  assert.deepEqual((await readDiagnostics(endpoint)).value.runtime.lifecycle, { locks: 0, unlocks: 0, suspends: 0, resumes: 0 });
  const [collectorCode] = await collectorExit;
  const resourceCollectorSupported = process.platform !== 'win32';
  assert.equal(collectorCode, resourceCollectorSupported ? 0 : 1, collectorLog);
  let collectorSummary = null;
  if (resourceCollectorSupported) {
    collectorSummary = JSON.parse(await (await import('node:fs/promises')).readFile(join(sampleOutput, 'summary.json'), 'utf8'));
    assert.ok(collectorSummary.samples >= 2); assert.ok(collectorSummary.segments.length >= 2, 'Diagnostic disable/re-enable is a new segment'); assert.equal(collectorSummary.fullTwoHourObservation, false);
    const sampleText = await (await import('node:fs/promises')).readFile(join(sampleOutput, 'samples.ndjson'), 'utf8');
    assert.ok(!sampleText.includes(endpoint.token) && !sampleText.includes('diagnostic private draft'));
  } else {
    assert.match(collectorLog, /OS process sampling currently supports Linux\/macOS/);
    assert.ok(!(await (await import('node:fs/promises')).readdir(root)).includes('passive-sampler'), 'Unsupported OS must not create a misleading sample report');
  }
  const before = first.value.store.revision;
  for (let i = 0; i < 5; i++) await readDiagnostics(endpoint);
  assert.equal((await readDiagnostics(endpoint)).value.store.revision, before);
  const frame = page.frames().find(f => f !== page.mainFrame());
  assert.equal(await frame.evaluate(() => typeof window.dshPetBridge), 'undefined');
  await send({ type: 'configure', options });
  for (let i = 0; i < 50 && (await listDiagnostics(registry)).length; i++) await pause(50);
  assert.deepEqual(await listDiagnostics(registry), []);
  assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n.selectionStart, n.selectionEnd]), ['diagnostic private draft', 2, 8]);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/diagnostics-native.json', JSON.stringify({ version: first.version, build: first.build, defaultOff: true, controlledLifecycleCounters: true, lifecycleClearsOnDisable: true, hotTogglePreservesDraft: true, readOnlyStoreRevision: true, tokenAndDraftOmitted: true, sandboxIsolated: true, interfaceWithdrawn: true, standaloneSampler: { supported: resourceCollectorSupported, samples: collectorSummary?.samples ?? 0, textAndTokenOmitted: resourceCollectorSupported, fullTwoHourObservation: false } }, null, 2) + '\n');
  console.log('Native diagnostics: default off, authenticated read, no draft text, hot toggle, read-only archive and sandbox isolation passed.');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
