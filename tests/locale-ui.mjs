import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';

let directory, server, browser;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-locale-ui-'));
  server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture(t, locale = 'en') {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { window.localeActions=[]; window.dshPetBridge={ subscribe(fn) { window.localeReceive=fn; }, action(value) { window.localeActions.push(value); }, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForSelector('#pet[data-character=whale][data-mode]');
  const receive = value => page.evaluate(value => window.localeReceive(value), value);
  const session = { id: 'source', label: '用户的中文会话', project: 'User project', mood: 'idle', unread: 1, chatAvailable: true };
  const result = { id: 'reply', sessionId: session.id, text: '**中文回复** stays unchanged.', time: 1, read: false };
  await receive({ type:'init', options:{locale,roam:false,notifications:false}, snapshot:{sessionId:session.id,mood:'idle',active:false,sessions:[session],results:[result]} });
  return { page, receive, session, result };
}
test('Harness English overrides the desktop browser language across the whole interface', async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('#chat-title').innerText(), 'I’m here. Take your time.');
  assert.equal(await page.locator('#message').getAttribute('placeholder'), 'Continue this conversation…');
  assert.equal(await page.locator('#characters header strong').innerText(), 'Characters and animation');
  assert.equal(await page.locator('#chat-session-name').innerText(), '用户的中文会话');
  assert.match(await page.locator('#menu-chat').innerText(), /Say something/);
  assert.match(await page.locator('#pet').getAttribute('aria-label'), /double-click to chat/);
  assert.equal(await page.locator('#menu-name').innerText(), 'DeepSeek Whale');
  const ownLabels = await page.evaluate(() => [...document.querySelectorAll('#stage button,#stage input,#stage textarea,#stage label,#stage header strong')].flatMap(node => [node.textContent,node.getAttribute('aria-label'),node.getAttribute('placeholder')]).filter(Boolean).filter(text => !text.includes('用户的中文会话')));
  assert.deepEqual(ownLabels.filter(text => /\p{Script=Han}/u.test(text)), [], 'English UI contains no hardcoded Chinese controls');
});
test('live language changes refresh open readers and character metadata without rewriting replies', async t => {
  const { page, receive } = await fixture(t);
  await page.locator('#attention').click();
  const reply = await page.locator('#reader-text').innerText();
  await receive({type:'configure',options:{locale:'zh'}});
  assert.equal(await page.locator('#reader-close').getAttribute('aria-label'), '收起完整回复');
  assert.equal(await page.locator('#chat-title').innerText(), '我在，慢慢说。');
  assert.equal(await page.locator('#reader-text').innerText(), reply);
  await receive({type:'configure',options:{locale:'en-US'}});
  assert.equal(await page.locator('#reader-close').getAttribute('aria-label'), 'Close full reply');
  assert.equal(await page.locator('#menu-name').innerText(), 'DeepSeek Whale');
  assert.equal(await page.locator('#reader-text').innerText(), reply);
  await page.keyboard.press('Escape');
  await page.locator('#open-characters').evaluate(node => node.click());
  await page.waitForFunction(() => !document.getElementById('character-use').disabled);
  assert.equal(await page.locator('#character-select option:checked').innerText(), 'DeepSeek Whale');
  assert.match(await page.locator('#character-credit').innerText(), /^Author:/);
  assert.equal(await page.locator('#character-action option:checked').innerText(), 'Wave');
  assert.equal(await page.locator('#character-action').evaluate(node => [...node.options].some(option => /\p{Script=Han}/u.test(option.textContent))), false, 'every built-in action has an English label');
  const selected = await page.locator('#character-scheme').inputValue();
  await receive({type:'configure',options:{locale:'zh-CN'}});
  assert.equal(await page.locator('#character-select option:checked').innerText(), 'DeepSeek 大肥鱼');
  assert.equal(await page.locator('#character-scheme').inputValue(), selected, 'language changes preserve the selected outfit');
  await mkdir('artifacts',{recursive:true}); await page.locator('#characters').screenshot({path:'artifacts/locale-character-zh.png'});
  await receive({type:'configure',options:{locale:'en'}});
  await page.locator('#characters').screenshot({path:'artifacts/locale-character-en.png'});
});

test('clearing the language preference follows the browser again and app diagnostics switch live', async t => {
  const { page, receive } = await fixture(t);
  await receive({type:'configure',options:{notifications:true}});
  await receive({type:'notice',notice:{sessionId:'source',title:'会话尚未就绪',body:'请先回到 Harness 打开这个会话，然后再发送消息。'}});
  assert.equal(await page.locator('#toast-title').innerText(),'Conversation not ready');
  await receive({type:'configure',options:{locale:null}});
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN','JSON IPC null clears the previous override');
  assert.equal(await page.locator('#toast-title').innerText(),'会话尚未就绪');
});
