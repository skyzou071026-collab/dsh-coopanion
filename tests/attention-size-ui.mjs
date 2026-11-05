import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';
import { controlNpc, npcTick } from './helpers/npc-life.mjs';
import { recordBodyOrders } from './helpers/body-orders.mjs';
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] }); });
after(async () => { await browser?.close(); });
const session = { id: 'attention-source', label: 'hi', project: 'dsh-usage-state', mood: 'idle', active: false, revision: 1, chatAvailable: true };
const snapshot = (source = session) => ({ mood: source.mood, active: false, sessionId: source.id, sessions: [source], results: [] });
async function fixture(t, mode = 'off', source = session) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-attention-size-'));
  const server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } }); page.setDefaultTimeout(5000);
  t.after(async () => { await page.close(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); });
  await controlNpc(page);
  await page.addInitScript(() => { window.actions = []; window.dshPetBridge = { subscribe(fn) { window.receive = fn; }, action(a) { window.actions.push(a); }, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForSelector('#pet[data-mode]');
  const receive = value => page.evaluate(value => window.receive(value), value);
  await receive({ type: 'init', baseline: true, options: { companionship: mode, roam: true, size: 180, locale: 'en' }, snapshot: snapshot(source) });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !['air', 'drag', 'crouch'].includes(document.querySelector('#pet').dataset.mode));
  return { page, receive, body: await recordBodyOrders(page) };
}

test('Take a look acknowledges this generic error, clearing envelope and sad expression', async t => {
  const source = { ...session, mood: 'error', text: 'The task needs attention.' };
  const { page, receive } = await fixture(t, 'off', source);
  await page.waitForSelector('#pet[data-mood=error]');
  await page.locator('#attention').click();
  await receive({ type: 'notice', notice: { id: 'error-queued-before-view', category: 'error', sessionId: source.id, requestIds: [], title: 'Needs attention', body: 'The task needs attention.' } });
  await page.locator('#inbox-issues button').click();
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type === 'open-session')), [{ type: 'open-session', sessionId: source.id }]);
  assert.equal(await page.locator('#attention').isVisible(), false, 'viewed error must leave the envelope');
  assert.equal(await page.locator('#pet').getAttribute('data-mood'), 'idle', 'viewed error must stop the persistent sad expression');
  await receive({ type: 'snapshot', snapshot: snapshot(source) });
  assert.equal(await page.locator('#attention').isVisible(), false, 'unchanged snapshot cannot resurrect the viewed error');
  await receive({ type: 'snapshot', snapshot: snapshot({ ...source, revision: 2 }) });
  assert.equal(await page.locator('#attention').isVisible(), true, 'a new error revision must ask for attention again');
  assert.equal(await page.locator('#pet').getAttribute('data-mood'), 'error');
});

test('typing, hovering and reading retain the configured body scale', async t => {
  const { page, body, receive } = await fixture(t, 'quiet');
  await receive({ type: 'configure', options: { size: 181 } });
  await receive({ type: 'configure', options: { size: 180 } });
  const scale = () => body.evaluate(() => window.bodyOrders.filter(e => e.t === 'set' && e.state.bounds).at(-1)?.state.bounds.S);
  await page.evaluate(() => { window.npcKeyboard = 'active'; }); await npcTick(page);
  assert.equal(await scale(), 180 / 256);
  await page.locator('#pet').hover(); await npcTick(page);
  assert.equal(await scale(), 180 / 256);
  await receive({ type: 'snapshot', snapshot: { ...snapshot(), results: [{ id: 'typing-reply', sessionId: session.id, time: 1, text: 'A reply while typing', read: false }] } });
  for (const selector of ['#attention', '#bubble']) {
    await page.locator(selector).hover(); await npcTick(page);
    assert.equal(await scale(), 180 / 256, selector + ' hover must retain configured size');
  }
  await page.mouse.move(0, 0);
  for (const keyboard of ['idle', 'active', 'unknown', 'idle']) {
    await page.evaluate(value => { window.npcKeyboard = value; }, keyboard);
    for (let i = 0; i < 15; i++) await npcTick(page);
    assert.equal(await scale(), 180 / 256, keyboard + ' cannot change body scale');
  }
  await receive({ type: 'ui-control', command: 'chat' }); await npcTick(page);
  assert.equal(await scale(), 180 / 256);
  await receive({ type: 'configure', options: { size: 210 } });
  await page.waitForFunction(() => document.querySelector('#pet').getBoundingClientRect().width > 155);
  assert.equal(await scale(), 210 / 256, 'explicit size configuration still applies');
});

test('Take a look never dismisses a real approval or question', async t => {
  const source = { ...session, mood: 'waiting' };
  const { page, receive } = await fixture(t, 'off', source);
  for (const kind of ['approval', 'question']) {
    await receive({ type: 'notification-state', snapshot: { protocol: 1, runtime: { phase: 'running', visible: true, generation: 1, visibilityRevision: 1, suspended: false }, interactions: [{ id: kind, sessionId: source.id, nativeId: kind, kind, turn: 1, seq: 1, state: 'open', preview: 'A real request', dueAt: null }] } });
    await page.locator('#attention').click(); await page.locator('[data-request-id][data-action=open]').click();
    assert.equal(await page.locator('#attention').isVisible(), true);
    assert.equal(await page.locator('#pet').getAttribute('data-mood'), 'waiting');
  }
});
