// Capture the real browser renderer with its built-in simulated Harness events.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { previewServer } from './preview.mjs';

const output = resolve('docs/assets/showcase');
const temporary = await mkdtemp(join(tmpdir(), 'coopanion-showcase-'));
const server = previewServer({ dataDir: join(temporary, 'figures') });
let browser;
try {
  await mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-character=whale][data-mode]');
  const clickPet = async (twice = false, options = {}) => {
    await page.waitForFunction(() => !['air', 'drag', 'crouch'].includes(document.getElementById('pet').dataset.mode));
    await page.locator('#pet')[twice ? 'dblclick' : 'click']({ ...options, force: true });
  };
  let frame = 0;
  const frames = async count => {
    for (let i = 0; i < count; i++) {
      const started = performance.now();
      await page.screenshot({ path: join(temporary, `${String(frame++).padStart(4, '0')}.png`) });
      await page.waitForTimeout(Math.max(0, 100 - (performance.now() - started)));
    }
  };
  const crop = async (name, selectors, padding = 24) => {
    const boxes = await Promise.all(selectors.map(selector => page.locator(selector).boundingBox()));
    assert.ok(boxes.every(Boolean), `visible screenshot subjects: ${name}`);
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)) - padding));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)) - padding));
    const right = Math.min(1200, Math.ceil(Math.max(...boxes.map(box => box.x + box.width)) + padding));
    const bottom = Math.min(800, Math.ceil(Math.max(...boxes.map(box => box.y + box.height)) + padding));
    await page.screenshot({ path: join(output, name), clip: { x, y, width: right - x, height: bottom - y } });
  };

  await page.locator('[data-demo=thinking]').click(); await frames(18);
  await page.locator('[data-demo=happy]').click(); await frames(36);
  await clickPet(true);
  await page.locator('#message').fill('继续聊聊刚才的任务'); await frames(24);
  await crop('conversation.png', ['#chat', '#pet']);
  await page.locator('#chat-close').click(); await frames(8);

  // Two unread conversations make the real inbox open instead of the single-reply shortcut.
  await page.locator('[data-demo=background]').click();
  await page.locator('#attention').click();
  await page.waitForSelector('#requests:not([hidden])');
  await crop('inbox.png', ['#requests', '#pet']);
  await page.locator('#requests-close').click();
  await clickPet(false, { button: 'right' });
  await page.locator('#open-characters').click();
  await page.waitForFunction(() => !document.getElementById('character-use').disabled);
  await page.locator('#character-scheme').selectOption('claude');
  await page.waitForFunction(() => !document.getElementById('character-use').disabled);
  await page.locator('#character-use').click();
  await page.waitForSelector('#pet[data-scheme=claude]');
  await page.locator('#character-action').selectOption('dance');
  await page.locator('#character-test').click(); await page.waitForTimeout(500);
  await crop('appearance.png', ['#characters'], 0);
  assert.deepEqual(errors, [], 'renderer must have no uncaught errors');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '10',
    '-i', join(temporary, '%04d.png'), '-filter_complex',
    '[0:v]scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', join(output, 'companion.gif')]);
  console.log(`Captured ${frame} frames and 3 screenshots in ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
