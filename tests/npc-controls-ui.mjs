import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';
import { controlNpc, npcTick, npcUntil } from './helpers/npc-life.mjs';
import { recordBodyOrders } from './helpers/body-orders.mjs';

let directory, server, browser;
const session = { id: 'npc-controls-focus', label: 'NPC controls session', mood: 'idle', active: false, chatAvailable: true };
const snapshot = (patch = {}) => ({ mood: 'idle', active: false, sessionId: session.id, sessions: [session], results: [], ...patch });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-npc-controls-ui-'));
  server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  await mkdir('artifacts', { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(r => server.close(r)); if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture(t, mode = 'quiet') {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } }); t.after(() => page.close()); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await controlNpc(page);
  await page.addInitScript(() => { window.npcControlsActions = []; window.dshPetBridge = { subscribe(fn) { window.npcControlsReceive = fn; }, action(a) { window.npcControlsActions.push(a); }, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-mode]');
  const receive = message => page.evaluate(message => window.npcControlsReceive(message), message);
  await receive({ type: 'init', baseline: true, options: { companionship: mode, size: 180, roam: true }, snapshot: snapshot() });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !['air', 'crouch', 'drag'].includes(document.querySelector('#pet').dataset.mode));
  return { page, receive, configure: options => receive({ type: 'configure', options }), body: await recordBodyOrders(page) };
}

test('off and automatic permission never fall back to random roaming; quiet and interactive use NPC', async t => {
  const { page, body, configure } = await fixture(t, 'off');
  for (const patch of [{ roam: false }, { roam: true }, { dailyRhythm: true }, { dailyRhythm: false }]) {
    await configure(patch); await npcTick(page, 5000);
    assert.equal(await page.evaluate(() => window.npcInput.enabled), false);
    assert.equal(await page.evaluate(() => window.npcState.walkId), null);
  }
  for (const companionship of ['quiet', 'interactive']) {
    await configure({ companionship }); await npcUntil(page, 'outbound');
    assert.ok(await page.evaluate(() => window.npcState.walkId > 0));
    await configure({ roam: false }); await npcTick(page);
    assert.equal(await page.evaluate(() => window.npcState.walkId), null);
    await configure({ roam: true, companionship: 'off' }); await npcTick(page);
  }
  const orders = await body.evaluate(() => window.bodyOrders);
  assert.ok(orders.some(e => e.t === 'set'));
  assert.ok(orders.filter(e => e.t === 'set').every(e => e.state.roam === 'off'));
});

test('hot preference keeps reader DOM/scroll, draft/focus/selection, request identity and bubble expiry', async t => {
  const { page, receive, configure } = await fixture(t);
  const reply = { id: 'npcControls-reply', sessionId: session.id, time: 1, read: false, text: '## Captured\n\n' + 'Keep reading this captured reply.\n\n'.repeat(60) };
  await receive({ type: 'snapshot', snapshot: snapshot({ results: [reply], sessions: [{ ...session, replyId: reply.id, reply: reply.text }] }) });
  await receive({ type: 'ui-control', command: 'chat' }); await page.locator('#message').fill('stable draft'); await page.locator('#message').evaluate(n => n.setSelectionRange(2, 7));
  await page.locator('#chat-read').click(); await page.locator('#reader-text').evaluate(n => { n.scrollTop = 120; window.npcControlsReader = n.firstChild; });
  const html = await page.locator('#reader-text').innerHTML(), actions = await page.evaluate(() => window.npcControlsActions.filter(a => a.type !== 'presentation'));
  for (const companionship of ['off', 'quiet', 'interactive', 'quiet']) await configure({ companionship });
  assert.equal(await page.locator('#reader-text').innerHTML(), html); assert.equal(await page.locator('#reader-text').evaluate(n => n.firstChild === window.npcControlsReader && n.scrollTop === 120), true);
  assert.deepEqual(await page.evaluate(() => window.npcControlsActions.filter(a => a.type !== 'presentation')), actions);
  await page.keyboard.press('Escape'); await receive({ type: 'ui-control', command: 'chat' });
  assert.equal(await page.locator('#message').inputValue(), 'stable draft');
  await page.locator('#message').evaluate(n => n.setSelectionRange(2, 7));
  for (const companionship of ['off', 'quiet']) await configure({ companionship });
  assert.deepEqual(await page.locator('#message').evaluate(n => [n === document.activeElement, n.selectionStart, n.selectionEnd]), [true, 2, 7]);
  await page.locator('#send').click(); const sent = await page.evaluate(() => window.npcControlsActions.find(a => a.type === 'chat'));
  assert.ok(sent?.requestId); await configure({ companionship: 'off' }); await configure({ companionship: 'quiet' });
  assert.equal(await page.locator('#message').inputValue(), 'stable draft');
  await receive({ type: 'chat-result', sessionId: sent.sessionId, requestId: sent.requestId, status: 'accepted' });
  assert.equal(await page.locator('#message').inputValue(), ''); assert.equal(await page.evaluate(() => window.npcControlsActions.filter(a => a.type === 'chat').length), 1);
  await page.keyboard.press('Escape'); await configure({ bubbleDurationMs: 2000 });
  await receive({ type: 'snapshot', snapshot: snapshot({ results: [{ ...reply, id: 'npcControls-short', text: 'Short reply' }] }) });
  // Short speech can finish during the entrance animation, hiding Show now
  // before a real click becomes actionable. Expiry starts at speech completion.
  await page.waitForSelector('#bubble[data-typing=false]');
  await page.mouse.move(0, 0); await page.locator('#pet').focus();
  await page.waitForTimeout(1200); for (const companionship of ['off', 'quiet', 'interactive', 'quiet']) await configure({ companionship });
  await page.locator('#bubble').waitFor({ state: 'hidden', timeout: 1500 });
});

