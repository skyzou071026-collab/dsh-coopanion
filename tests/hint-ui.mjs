import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';

const directory = await mkdtemp(join(tmpdir(), 'dsh-hint-ui-'));
const server = previewServer({ dataDir: directory });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;

const runtime = (generation, overrides = {}) => ({
  protocol: 1,
  runtime: { phase: 'running', visible: true, generation, visibilityRevision: 4, suspended: false, ...overrides },
  interactions: [],
});
const hidden = generation => runtime(generation, { visible: false });

const box = (page, selector) => page.locator(selector).evaluate(element => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
    clientWidth: element.clientWidth, clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
    lineHeight: parseFloat(style.lineHeight) || 0,
  };
});

const assertInside = (value, viewport, label) => {
  assert.ok(value.left >= -0.5, `${label}: left edge ${value.left}`);
  assert.ok(value.top >= -0.5, `${label}: top edge ${value.top}`);
  assert.ok(value.right <= viewport.width + 0.5, `${label}: right edge ${value.right} exceeds ${viewport.width}`);
  assert.ok(value.bottom <= viewport.height + 0.5, `${label}: bottom edge ${value.bottom} exceeds ${viewport.height}`);
};

const assertTextFits = (value, label) => {
  assert.ok(value.scrollWidth <= value.clientWidth + 1, `${label}: horizontal overflow ${value.scrollWidth} > ${value.clientWidth}`);
  assert.ok(value.lineHeight > 0, `${label}: line height is not resolved`);
  assert.ok(value.clientHeight + 1 >= value.lineHeight, `${label}: text is clipped above one line (${value.clientHeight} < ${value.lineHeight})`);
  assert.ok(
    value.clientHeight + 1.5 >= Math.min(value.lineHeight * 2, value.scrollHeight),
    `${label}: text is clipped through a line (${value.clientHeight} of ${value.scrollHeight} with line height ${value.lineHeight})`,
  );
};

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.hintActions = [];
    window.dshPetBridge = {
      subscribe(fn) { window.n2Receive = fn; },
      action(action) { window.hintActions.push(action); },
      hit() {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-character=whale][data-mode]');
  const receive = message => page.evaluate(message => window.n2Receive(message), message);
  const actions = () => page.evaluate(() => window.hintActions);
  await receive({
    type: 'init',
    options: { locale: 'zh-CN', reminders: true, notifications: true, bubbleDurationMs: 60000 },
    snapshot: { mood: 'idle', sessionId: 'hint-target', sessions: [{ id: 'hint-target', label: 'Hint target', mood: 'idle', chatAvailable: true }], results: [] },
  });
  await receive({ type: 'notification-state', snapshot: runtime(7) });

  const hint = (title, body, sessionId = 'hint-target') => ({ type: 'notice', notice: { title, body, sessionId, kind: 'message' }, generation: 7 });
  const show = async (title, body, sessionId) => {
    await receive(hint(title, body, sessionId));
    await page.locator('#toast:not([hidden])').waitFor();
  };
  const withdraw = async () => {
    await receive({ type: 'notification-state', snapshot: hidden(7) });
    await page.waitForFunction(() => document.getElementById('toast').hidden);
    await receive({ type: 'notification-state', snapshot: runtime(7) });
  };

  // A real hint payload renders and its click carries the exact session identity.
  await show('电话接通了', '挂件正在听你说话', 'hint-source  exact');
  assert.equal(await page.locator('#toast-title').innerText(), '电话接通了');
  assert.equal(await page.locator('#toast-body').innerText(), '挂件正在听你说话');
  await page.locator('#toast').click();
  await page.waitForFunction(() => window.hintActions.some(action => action.type === 'open-session'));
  assert.deepEqual((await actions()).find(action => action.type === 'open-session'), { type: 'open-session', sessionId: 'hint-source  exact' });
  assert.equal(await page.locator('#toast').isVisible(), false, 'clicking a hint dismisses it');

  // Losing the runtime withdraws the hint and showing again does not replay it.
  await show('可见性测试', '窗口隐藏后应当撤下。');
  await receive({ type: 'notification-state', snapshot: hidden(7) });
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  await receive({ type: 'notification-state', snapshot: runtime(7) });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#toast').isVisible(), false, 'restoring visibility does not replay a withdrawn hint');

  // Lock/suspend is a separate runtime failure from plain hiding.
  await show('锁屏测试', '锁屏或休眠后也应撤下。');
  await receive({ type: 'notification-state', snapshot: runtime(7, { suspended: true }) });
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  await receive({ type: 'notification-state', snapshot: runtime(7) });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#toast').isVisible(), false, 'unlocking does not replay a withdrawn hint');

  // A newer generation invalidates the old toast; a stale snapshot does not.
  await show('代次测试', '新一代拉起时清掉旧提示。');
  await receive({ type: 'notification-state', snapshot: runtime(8) });
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  await show('旧代次测试', '旧快照不能误撤新提示。');
  await receive({ type: 'notification-state', snapshot: runtime(6) });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#toast').isVisible(), true, 'a stale generation snapshot cannot withdraw a newer hint');
  await receive({ type: 'notification-state', snapshot: runtime(7) });
  await withdraw();

  // A hint without a forwarded generation still follows the current runtime.
  await receive({ type: 'notice', notice: { title: '无代次提示', body: '普通 toast 也必须受运行时门控。', sessionId: 'hint-target', kind: 'message' } });
  await page.locator('#toast:not([hidden])').waitFor();
  await receive({ type: 'notification-state', snapshot: hidden(7) });
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  await receive({ type: 'notification-state', snapshot: runtime(7) });

  // A recovered window accepts a new hint (the inverse of "do not replay").
  await show('恢复后的新提示', '恢复显示后新的提示仍然要出现。');
  await withdraw();

  // Legitimate maximum payloads must stay inside the viewport at every text scale.
  const payloads = [
    ['latin', 'T'.repeat(256), 'B'.repeat(2048)],
    ['url', 'U'.repeat(256), `https://example.com/${'a'.repeat(1900)}`],
    ['chinese', '中文标题'.repeat(64), '这是正文。'.repeat(400)],
  ];
  for (const viewport of [{ width: 1200, height: 800 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [1, 1.25, 1.5]) {
      await receive({ type: 'configure', options: { textScale: scale, locale: 'zh-CN' } });
      await page.waitForFunction(expected => getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim() === String(expected), scale);
      for (const [name, title, body] of payloads) {
        await show(title, body);
        const label = `${name}@${viewport.width}x${viewport.height}/${scale}`;
        const toast = await box(page, '#toast');
        const titleBox = await box(page, '#toast-title');
        const bodyBox = await box(page, '#toast-body');
        assertInside(toast, viewport, `${label} toast`);
        assertInside(titleBox, viewport, `${label} title`);
        assertInside(bodyBox, viewport, `${label} body`);
        assertTextFits(titleBox, `${label} title`);
        assertTextFits(bodyBox, `${label} body`);
        assert.ok(toast.scrollHeight <= toast.clientHeight + 1, `${label}: toast scrolls vertically (${toast.scrollHeight} > ${toast.clientHeight})`);
        await withdraw();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('hint-ui: native hint behavior and layout constraints verified');
} finally {
  if (browser) await browser.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
