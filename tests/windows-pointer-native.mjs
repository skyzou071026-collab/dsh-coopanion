import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { petClick, nativeClick } from './helpers/native-pointer.mjs';

assert.equal(process.platform, 'win32', 'Use an isolated Windows interactive desktop');
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'dsh-windows-pointer-'));
let app;
try {
  app = await _electron.launch({
    executablePath: require('electron'), args: ['--no-sandbox', resolve('desktop/main.cjs')],
    env: { ...process.env, DSH_PET_TEST_DATA_DIR: root, DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_DEBUG_PORT: '0' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { waitUntil: 'load' });
  await app.evaluate((_, options) => process.emit('message', {
    type: 'init', baseline: true, options,
    snapshot: { mood: 'idle', active: false, sessions: [], results: [] },
  }), { size: 150, roam: false, companionship: 'off', notifications: false, bubbleDurationMs: 12000 });
  await page.waitForSelector('#pet[data-display-revision]');
  const scale = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  assert.equal(scale, Number(process.env.DSH_WINDOWS_EXPECT_SCALE ?? 1.25), 'Use real system scaling without a Chromium override');
  await petClick(page, { button: 'right' });
  assert.equal(await page.locator('#menu').isVisible(), true, 'Native hit testing must allow the context menu');
  const measurement = await nativeClick(page, '#open-characters');
  await page.locator('#characters:not([hidden])').waitFor();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/windows-pointer-native.json', JSON.stringify({
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    build: JSON.parse(await readFile('dist/build-info.json', 'utf8')),
    scale, measurement, nativeContextMenu: true, nativePanelClick: true, physicalMultiDisplay: false,
  }, null, 2) + '\n');
  console.log('Windows native pointer passed at actual scale ' + scale);
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
