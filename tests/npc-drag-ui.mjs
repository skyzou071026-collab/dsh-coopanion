import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';
import { controlNpc, npcTick, npcUntil } from './helpers/npc-life.mjs';
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] }); });
after(async () => { await browser?.close(); });
async function fixture(t, mode = 'quiet', videoPath) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-npc-drag-'));
  const server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, ...(videoPath ? { recordVideo: { dir: 'artifacts/home-marker-video', size: { width: 1000, height: 750 } } } : {}) }); page.setDefaultTimeout(5000);
  t.after(async () => { await page.close(); if (videoPath) await page.video().saveAs(videoPath); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await controlNpc(page);
  await page.addInitScript(() => { window.dshPetBridge = { subscribe(fn) { window.receive = fn; }, action() {}, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForSelector('#pet[data-mode]');
  const receive = value => page.evaluate(value => window.receive(value), value);
  await receive({ type: 'init', baseline: true, options: { companionship: mode, roam: true, size: 180 }, snapshot: { mood: 'idle', active: false, sessionId: null, sessions: [], results: [] } });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !['air', 'drag', 'crouch'].includes(document.querySelector('#pet').dataset.mode));
  const frame = page.frames().find(f => f.url().includes('figure-frame.html'));
  await frame.evaluate(() => { Math.random = () => .9; window.orders = []; addEventListener('message', e => { if (['set', 'walk', 'stop-walk', 'place', 'pointer', 'drop'].includes(e.data?.t)) window.orders.push(e.data); }); });
  await receive({ type: 'configure', options: { size: 181 } }); await receive({ type: 'configure', options: { size: 180 } });
  await page.waitForFunction(() => window.npcInput?.layout);
  return { page, frame, receive };
}
const layout = page => page.evaluate(() => window.npcInput.layout);
async function drag(page, target) {
  const box = await page.locator('#pet').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(target, box.y + box.height / 2, { steps: 8 });
  await page.waitForSelector('#pet[data-mode=drag]');
  await page.mouse.move(target + 1, box.y + box.height / 2);
  await page.mouse.up(); await page.mouse.move(0, 0);
}
async function record(name, page, frame) {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/' + name + '.json', JSON.stringify({ state: await page.evaluate(() => window.npcState), trace: await page.evaluate(() => window.npcTrace), layout: await layout(page), orders: await frame.evaluate(() => window.orders) }, null, 2) + '\n');
}

test('selection, typing and dragging always retain the configured size', async t => {
  const { page, frame } = await fixture(t);
  await page.evaluate(() => { window.npcKeyboard = 'active'; }); await npcTick(page);
  await page.locator('#pet').focus(); await page.keyboard.type('ab'); await npcTick(page);
  await record('npc-drag-size', page, frame);
  const scales = await frame.evaluate(() => window.orders.filter(o => o.t === 'set' && o.state.bounds).map(o => o.state.bounds.S));
  assert.equal(scales.at(-1), 180 / 256, 'keyboard activity must not shrink a selected pet');
  await drag(page, 700); await npcTick(page);
  assert.equal(await frame.evaluate(() => window.orders.filter(o => o.t === 'set' && o.state.bounds).at(-1).state.bounds.S), 180 / 256);
});

for (const mode of ['off', 'quiet']) for (const target of [10, 990]) test(`a fast placement at the edge drops without an automatic reverse throw (${mode}, ${target})`, async t => {
  const { page, frame } = await fixture(t, mode);
  await drag(page, target);
  await page.waitForFunction(target => target < 500 ? window.npcInput.layout.x < 100 : window.npcInput.layout.x > 900, target);
  const samples = [];
  for (let i = 0; i < 12; i++) { samples.push((await layout(page)).x); await page.waitForTimeout(40); }
  await record('npc-drag-edge-' + mode + '-' + target, page, frame);
  assert.ok(Math.max(...samples) - Math.min(...samples) < 12, 'placing at the edge must not recoil across the screen: ' + JSON.stringify(samples));
  for (let i = 0; i < 20; i++) await npcTick(page);
  assert.equal(await frame.evaluate(() => window.orders.some(o => ['walk', 'place'].includes(o.t))), false, 'outside-area drop must remain user-owned');
});

test('manual relocation before the first NPC departure cannot be overwritten by home placement', async t => {
  const { page, frame } = await fixture(t);
  assert.equal(await page.evaluate(() => window.npcState.placed), false);
  await drag(page, 700);
  await page.waitForFunction(() => !['air', 'drag', 'crouch', 'land'].includes(document.querySelector('#pet').dataset.mode));
  await frame.evaluate(() => { window.orders = []; });
  for (let i = 0; i < 16; i++) await npcTick(page);
  await record('npc-drag-initial', page, frame);
  assert.equal(await frame.evaluate(() => window.orders.some(o => o.t === 'place')), false, 'a user drop must replace the initial automatic home placement');
});

test('dragging an outbound pet releases its old walk target', async t => {
  const { page, frame } = await fixture(t);
  await npcUntil(page, 'outbound'); const target = await page.evaluate(() => window.npcState.target);
  await drag(page, 750); await npcTick(page);
  await record('npc-drag-intent', page, frame);
  assert.equal(await page.evaluate(() => window.npcState.target), null, 'manual relocation must retire the old target ' + target);
  assert.equal(await page.evaluate(() => window.npcState.walkId), null);
});

test('cancelling a drag drops at the last valid pointer without retaining a held body', async t => {
  const { page, frame } = await fixture(t);
  const box = await page.locator('#pet').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(720, box.y + box.height / 2, { steps: 8 });
  await page.waitForSelector('#pet[data-mode=drag]');
  await page.locator('#pet').dispatchEvent('pointercancel', { pointerId: 1, clientX: 0, clientY: 0 });
  await page.mouse.up(); await page.mouse.move(0, 0);
  await page.waitForFunction(() => !['drag', 'air', 'land'].includes(document.querySelector('#pet').dataset.mode));
  const before = (await layout(page)).x;
  await page.mouse.move(950, 600); await page.waitForTimeout(150);
  assert.ok(Math.abs((await layout(page)).x - before) < 4);
  assert.ok(before > 650 && before < 780, 'cancel must use the last valid drag point');
  assert.equal(await frame.evaluate(() => window.orders.some(o => o.t === 'drop')), true);
});

test('home marker remains fixed throughout a held drag and release', async t => {
  const { page } = await fixture(t, 'quiet', process.env.DSH_HOME_MARKER_VIDEO);
  const home = () => page.locator('#npc-home').evaluate(n => parseFloat(n.style.left));
  const initial = await home(), box = await page.locator('#pet').boundingBox();
  const points = [{ phase: 'before', home: initial, layout: await layout(page) }];
  await page.waitForTimeout(500);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  for (const target of [990, 15, 850]) {
    await page.mouse.move(target, box.y + box.height / 2, { steps: 18 });
    await page.waitForSelector('#pet[data-mode=drag]');
    await page.waitForTimeout(450);
    points.push({ phase: 'held-' + target, home: await home(), layout: await layout(page) });
  }
  await page.mouse.up(); await page.mouse.move(0, 0);
  await page.waitForTimeout(700);
  points.push({ phase: 'released', home: await home(), layout: await layout(page) });
  await mkdir('artifacts', { recursive: true });
  await writeFile(process.env.DSH_HOME_MARKER_TRACE ?? 'artifacts/home-marker-drag.json', JSON.stringify(points, null, 2) + '\n');
  console.log('Home marker drag positions:', JSON.stringify(points.map(p => [p.phase, p.home])));
  assert.ok(points.every(p => Math.abs(p.home - initial) < 1), 'home must stay anchored while held, not just restore after release');
});

test('home marker follows explicit settings but stays fixed while dragging a large pet at either edge', async t => {
  const { page, receive } = await fixture(t);
  const home = () => page.locator('#npc-home').evaluate(n => parseFloat(n.style.left));
  let previous;
  for (const npcHome of [.05, .95]) {
    await receive({ type: 'configure', options: { size: 240, npcHome } });
    await page.waitForTimeout(120);
    const initial = await home();
    if (previous !== undefined) assert.ok(initial > previous + 500, 'changing home percentage must still relocate the marker');
    previous = initial;
    const box = await page.locator('#pet').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    for (const target of [5, 995]) {
      await page.mouse.move(target, box.y + box.height / 2, { steps: 12 });
      await page.waitForSelector('#pet[data-mode=drag]'); await page.waitForTimeout(120);
      assert.ok(Math.abs(await home() - initial) < 1);
    }
    await page.mouse.up(); await page.mouse.move(0, 0);
    await page.waitForFunction(() => !['air', 'drag', 'land'].includes(document.querySelector('#pet').dataset.mode));
    assert.ok(Math.abs(await home() - initial) < 1);
  }
});
