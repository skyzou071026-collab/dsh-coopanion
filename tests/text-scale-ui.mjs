import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';
import { observeBodyReady } from './helpers/body-startup.mjs';

let directory, server, browser;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-text-scale-'));
  server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  await mkdir('artifacts', { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); if (directory) await rm(directory, { recursive: true, force: true }); });
const longText = '## 阅读中的捕获正文 · Captured reply\n\n' + '放大后继续阅读，草稿与会话保持。 Read without changing the target.\n\n'.repeat(24) + '```js\n' + 'const longCode = "' + 'a'.repeat(200) + '";\n```\n\n| ' + Array.from({ length: 8 }, (_, i) => 'Column ' + i).join(' | ') + ' |\n| ' + '--- | '.repeat(8) + '\n| ' + 'LongTableCell | '.repeat(8) + '\n';
const focus = { id: 'scale-focus', label: '当前会话 · Focused session', mood: 'idle', chatAvailable: true };
const source = { id: 'scale-source', label: '后台结果 · Background reply', mood: 'idle', unread: 1, chatAvailable: true };
const result = { id: 'scale-result', sessionId: source.id, text: longText, time: 1, read: false };
const snapshot = results => ({ mood: 'idle', active: false, sessionId: focus.id, sessions: [focus, source], results });
async function fixture(t, locale = 'zh-CN') {
  const page = await browser.newPage({ locale, viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000); t.after(() => page.close());
  const waitForBody = observeBodyReady(page, `text-scale-${locale}`);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { window.scaleActions = []; window.dshPetBridge = { subscribe(fn) { window.scaleReceive = fn; }, action(a) { window.scaleActions.push(a); }, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await waitForBody();
  const receive = message => page.evaluate(message => window.scaleReceive(message), message);
  await receive({ type: 'init', baseline: true, options: { size: 90, textScale: 1, roam: false, locale: locale.startsWith('zh') ? 'zh' : 'en' }, snapshot: snapshot([result]) });
  return { page, receive, configure: options => receive({ type: 'configure', options }) };
}
export async function contained(page, selector) {
  await page.waitForFunction(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }, selector);
  assert.ok(await page.locator(selector).evaluate(n => n.scrollWidth <= n.clientWidth + 1), `${selector} has no unintended horizontal overflow`);
}
for (const locale of ['zh-CN', 'en-US']) test(`${locale}: all text scales × character extremes keep reader, inbox and draft usable`, async t => {
  const { page, receive, configure } = await fixture(t, locale);
  const samples = [];
  await receive({ type: 'ui-control', command: 'chat' });
  await page.locator('#message').fill('未发送的草稿 · unsent draft');
  await page.locator('#message').evaluate(n => n.setSelectionRange(3, 7));
  await page.keyboard.press('Escape');
  await page.locator('#attention').click();
  assert.equal(await page.locator('#reader').isVisible(), true);
  await page.locator('#reader-text').evaluate(n => { n.scrollTop = 140; window.scaleReaderChild = n.firstChild; });
  const actions = await page.evaluate(() => window.scaleActions);
  const html = await page.locator('#reader-text').innerHTML();
  // A new result while reading must remain unread and must not replace captured text.
  await receive({ type: 'snapshot', snapshot: snapshot([result, { ...result, id: 'scale-new', time: 2, text: 'New incoming result' }]) });
  for (const size of [90, 240]) for (const textScale of [1, 1.25, 1.5]) {
    await configure({ size, textScale });
    await contained(page, '#reader');
    assert.equal(await page.locator('#reader-text').innerHTML(), html);
    assert.equal(await page.evaluate(() => document.querySelector('#reader-text').firstChild === window.scaleReaderChild), true, 'reader DOM is retained');
    assert.equal(await page.locator('#reader-text').evaluate(n => n.scrollTop), 140);
    const stable = await page.locator('#reader').boundingBox();
    await page.waitForTimeout(80);
    assert.deepEqual(await page.locator('#reader').boundingBox(), stable, 'reflow settles without repeated jumps');
    const font = await page.locator('#reader-text').evaluate(n => parseFloat(getComputedStyle(n).fontSize));
    assert.equal(font, 14 * textScale);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--size')), `${size}px`);
    assert.equal(await page.locator('#reader-text pre').evaluate(n => n.scrollWidth > n.clientWidth), true, 'long code keeps horizontal scroll');
    assert.equal(await page.locator('#reader-text table').evaluate(n => n.scrollWidth > n.clientWidth), true, 'wide table keeps horizontal scroll');
    await page.screenshot({ path: `artifacts/text-scale-${locale}-${size}-${textScale}.png` });
    samples.push({ locale, size, textScale, font, readerContained: true, scrollTop: 140 });
  }
  assert.deepEqual(await page.evaluate(() => window.scaleActions), actions, 'scaling and incoming results do not select, acknowledge, or submit');
  await page.locator('#reader-inbox').click();
  for (const size of [90, 240]) for (const textScale of [1, 1.25, 1.5]) {
    await configure({ size, textScale }); await contained(page, '#requests');
    assert.equal(await page.locator('.inbox-card').first().evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 13 * textScale);
  }
  await page.screenshot({ path: `artifacts/text-scale-inbox-${locale}.png` });
  await page.locator('#inbox-replies [data-action=read]').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('#reader').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await receive({ type: 'ui-control', command: 'chat' });
  assert.equal(await page.locator('#message').inputValue(), '未发送的草稿 · unsent draft');
  const selection = await page.locator('#message').evaluate(n => [n.selectionStart, n.selectionEnd]);
  for (const size of [90, 240]) for (const textScale of [1, 1.5, 1.25, 1, 1.5]) { await configure({ size, textScale }); await contained(page, '#chat');
    assert.equal(await page.locator('#message').evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 13 * textScale); }
  assert.equal(await page.locator('#message').inputValue(), '未发送的草稿 · unsent draft');
  assert.deepEqual(await page.locator('#message').evaluate(n => [n.selectionStart, n.selectionEnd]), selection);
  assert.equal(await page.locator('#message').evaluate(n => n === document.activeElement), true);
  await page.screenshot({ path: `artifacts/text-scale-chat-${locale}.png` });
  // Keyboard submission retains its exact in-flight identity across resizing.
  await page.locator('#message').press('Control+Enter');
  const sent = await page.evaluate(() => window.scaleActions.filter(a => a.type === 'chat'));
  assert.equal(sent.length, 1);
  await configure({ textScale: 1.25 }); await configure({ textScale: 1.5 });
  assert.equal(await page.locator('#message').inputValue(), sent[0].text);
  assert.deepEqual(await page.evaluate(() => window.scaleActions.filter(a => a.type === 'chat')), sent);
  await receive({ type: 'chat-result', sessionId: sent[0].sessionId, requestId: sent[0].requestId, status: 'accepted' });
  assert.equal(await page.locator('#message').inputValue(), '');
  await writeFile(`artifacts/text-scale-${locale}.json`, JSON.stringify(samples, null, 2) + '\n');
});

test('text scaling keeps final bubble font and original dismissal clock', async t => {
  const { page, receive, configure } = await fixture(t);
  await configure({ bubbleDurationMs: 2000 });
  await receive({ type: 'snapshot', snapshot: snapshot([{ ...result, id: 'scale-bubble', sessionId: focus.id, text: '回复气泡 · Reply bubble' }]) });
  await page.locator('#bubble:not([hidden])').waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1100);
  await configure({ textScale: 1.5 });
  assert.equal(await page.locator('#bubble').evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 21.75);
  await contained(page, '#bubble');
  await page.locator('#bubble').waitFor({ state: 'hidden', timeout: 1500 });
});
