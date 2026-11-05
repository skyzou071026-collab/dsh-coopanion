import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { controlNpc, npcUntil } from './helpers/npc-life.mjs';
import { parkNativePointer } from './helpers/native-pointer.mjs';

assert.equal(process.platform, 'win32', 'Run this test on an isolated Windows interactive desktop');
const require = createRequire(import.meta.url), run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dsh-windows-geometry-'));
const taskbarSource = await readFile(new URL('./helpers/windows-taskbar.ps1', import.meta.url), 'utf8');
const taskbar = async state => {
  const script = `$requestedState=${state === undefined ? '$null' : Number(state)};\n` + taskbarSource;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
};
const originalTaskbar = (await taskbar()).before;
let app, page;
const samples = [], errors = [];
try {
  app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', resolve('desktop/main.cjs')], env: { ...process.env, DSH_PET_TEST_DATA_DIR: root, DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_DEBUG_PORT: '0' } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  // firstWindow observes window creation, before main's loadURL can finish.
  // Reloading that initial navigation makes native startup abort instead.
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { waitUntil: 'load' });
  await controlNpc(page);
  await page.addInitScript(() => { window.npcPointer = null; });
  const options = { size: 180, roam: true, companionship: 'quiet', notifications: false, bubbleDurationMs: 12000 };
  await app.evaluate((_, options) => process.emit('message', { type: 'init', baseline: true, options, snapshot: { mood: 'idle', active: false, sessions: [], results: [] } }), options);
  await page.reload(); await page.waitForSelector('#pet[data-mode][data-display-revision]');
  await parkNativePointer(page);
  const sample = () => page.evaluate(async () => ({ viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, reason: document.querySelector('#pet').dataset.npcReason,
    native: await window.dshPetBridge.testScreenPoint({ x: 0, y: 0, width: innerWidth, height: innerHeight }) }));
  const settled = async () => {
    let value;
    for (let i = 0; i < 60; i++) {
      value = await sample();
      const bounds = value.native.contentBounds, geometry = value.native.geometry;
      if (bounds.width === value.viewport.width && bounds.height === value.viewport.height && geometry.contentBounds.width === bounds.width && geometry.contentBounds.height === bounds.height && value.reason !== 'geometry') return value;
      await page.waitForTimeout(100);
    }
    assert.fail('Native geometry failed to settle: ' + JSON.stringify(value));
  };
  const initial = await settled();
  assert.equal(initial.native.geometry.scaleFactor, Number(process.env.DSH_WINDOWS_EXPECT_SCALE ?? 1.25), 'DPI must come from Windows, without a forced Chromium scale');
  await npcUntil(page, 'outbound');
  await page.evaluate(() => { window.originalGeometryBody = document.querySelector('#body-layer iframe'); });
  for (const state of [originalTaskbar | 1, originalTaskbar & ~1, originalTaskbar | 1]) {
    const changed = await taskbar(state); assert.equal(changed.after & 1, state & 1);
    await page.waitForTimeout(300);
    samples.push({ taskbar: changed.after, ...await settled() });
    await npcUntil(page, 'outbound');
  }
  assert.ok(new Set(samples.map(s => s.native.geometry.workArea.height)).size > 1, 'Real taskbar changes must exercise different workArea heights');
  // Keep native bounds stale until the renderer has observed the pause. The
  // window, actual viewport, revision protocol and resync IPC remain real.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0], original = win.getContentBounds.bind(win), bounds = original();
    globalThis.dshGeometryRestore = () => { win.getContentBounds = original; };
    win.getContentBounds = () => ({ ...bounds, height: bounds.height + 48 });
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
  });
  await page.waitForSelector('#pet[data-npc-reason=geometry]');
  await app.evaluate(() => globalThis.dshGeometryRestore());
  const recovered = await settled(); await npcUntil(page, 'outbound');
  assert.equal(await page.evaluate(() => document.querySelector('#body-layer iframe') === window.originalGeometryBody), true);
  assert.deepEqual(errors, []);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/windows-geometry-native.png' });
  await writeFile('artifacts/windows-geometry-native.json', JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), build: JSON.parse(await readFile('dist/build-info.json', 'utf8')), initial, samples, recovered,
    windowsDpiFromSystem: true, realTaskbarChanges: true, controlledStaleBounds: true, controlledNpcClockAndPerception: true, sameCharacterFrame: true, physicalMultiDisplay: false }, null, 2) + '\n');
  console.log('Windows native geometry passed: system DPI, actual taskbar workAreas, stale-bound resync and retained character.');
} finally { await app?.close(); await taskbar(originalTaskbar); await rm(root, { recursive: true, force: true }); }
