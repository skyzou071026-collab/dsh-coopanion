import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createRequire } from 'node:module';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { controlCompanionClock, advanceCompanion } from './helpers/companionship.mjs';
import { controlNpc, npcTick, npcUntil } from './helpers/npc-life.mjs';
import { recordBodyOrders } from './helpers/body-orders.mjs';
const require = createRequire(import.meta.url);
const { CharacterStore } = require('../dist/character-store.cjs'), { CompanionStore } = require('../dist/companion-store.cjs'), { createPetServer } = require('../dist/figure-server.cjs');
let browser;
before(async () => { await mkdir('artifacts', { recursive: true }); browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] }); });
after(async () => { await browser?.close(); });
const session = { id: 'companion-focus', label: 'Companion focus', mood: 'idle', active: false, chatAvailable: true };
const snapshot = patch => ({ mood: 'idle', active: false, sessionId: session.id, sessions: [session], results: [], ...patch });
async function fixture(t, mode = 'interactive', vocab, star = false, timing = null) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-ui-'));
  let ownerNow = new Date(2026, 9, 15, 12).getTime();
  const store = new CompanionStore(join(directory, 'care'), () => ownerNow);
  const characters = new CharacterStore(join(directory, 'figures'), resolve('web/upstream/whale'));
  if (star) {
    const manifest = JSON.parse(await readFile('examples/star/figure.json', 'utf8')); manifest.can = { walk: false };
    const imported = await characters.import(zipSync({ 'figure.json': strToU8(JSON.stringify(manifest)), 'figure.js': new Uint8Array(await readFile('examples/star/figure.js')) }));
    await characters.select(imported.importedId);
  }
  const server = createPetServer({ webRoot: resolve('web'), store: characters, companions: store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } }); page.setDefaultTimeout(10000);
  t.after(async () => { await page.close(); await new Promise(r => server.close(r)); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  if (timing) {
    // A frame timestamp can precede a click callback's performance.now().
    // Keep real event time and physics; expose that ordering deterministically.
    await page.addInitScript(lag => { const raf = requestAnimationFrame.bind(window); window.requestAnimationFrame = callback => raf(time => callback(time - lag)); }, timing.frameLag ?? 0);
  } else { await controlCompanionClock(page); await controlNpc(page); }
  if (vocab) await page.route('**/api/characters/load', async route => { const response = await route.fetch(), result = await response.json(); result.value.vocab = result.value.vocab.filter(w => vocab.includes(w.id)); await route.fulfill({ response, json: result }); });
  await page.addInitScript(() => { window.actions = []; addEventListener('message', e => { if (e.data?.t === 'frame' && e.data.layout) window.lastNpcLayout = e.data.layout; }); window.dshPetBridge = { subscribe(fn) { window.receive = fn; }, action(a) { window.actions.push(a); }, hit() {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-mode]');
  const receive = msg => page.evaluate(msg => window.receive(msg), msg);
  await receive({ type: 'init', baseline: true, options: { companionship: mode, roam: true, locale: 'zh' }, snapshot: snapshot() });
  await page.mouse.move(0, 0);
  if (timing) await page.waitForSelector('#pet[data-mode=idle]');
  else await page.waitForFunction(() => window.companionState?.blocked === false);
  const body = await recordBodyOrders(page);
  return { page, directory, store, receive, setDay: (day, minutes = 0) => { ownerNow = new Date(2026, 9, day, 12).getTime() + minutes * 60000; }, read: () => store.request({ type: 'read', characterId: 'whale' }), configure: options => receive({ type: 'configure', options }), body };
}
async function tickNext(page, extra = 0) { await advanceCompanion(page, await page.evaluate(() => window.companionState.active?.dueAt) + extra); }
async function finishActivity(page) {
  const body = page.frames().find(frame => frame.url().includes('figure-frame.html'));
  assert.ok(body, 'live API 2 body frame exists');
  // The real tick handler runs first; this observer only acknowledges processing.
  await body.evaluate(() => addEventListener('message', event => {
    if (event.source === parent && event.data?.t === 'tick' && Number.isSafeInteger(event.data.companionTestTick))
      parent.postMessage({ t: 'companion-test-tick-ack', id: event.data.companionTestTick }, '*');
  }));
  await page.evaluate(() => { window.companionPhysicsTicks = 0; });
  for (let i = 0; i < 6 && await page.evaluate(() => !!window.companionState.active); i++) {
    const index = await page.evaluate(() => window.companionState.active.index);
    await tickNext(page);
    // Actual body inputs and the original progress predicate share this ten-second wait.
    await page.waitForFunction(async index => {
      if (!window.companionState.active || window.companionState.active.index !== index) return true;
      const frame = document.querySelector('#body-layer iframe');
      if (!frame?.contentWindow) throw new Error('Live body frame required');
      const tick = () => new Promise((resolve, reject) => {
        const id = ++window.companionPhysicsTicks;
        let layout;
        const receive = event => {
          if (event.source !== frame.contentWindow) return;
          if (event.data?.t === 'frame') layout = event.data.layout;
          if (event.data?.t !== 'companion-test-tick-ack' || event.data.id !== id) return;
          removeEventListener('message', receive);
          if (typeof layout?.moving !== 'boolean') reject(new Error('Invalid body motion report'));
          else resolve(layout);
        };
        addEventListener('message', receive);
        frame.contentWindow.postMessage({ t: 'tick', dt: .05, companionTestTick: id }, '*');
      });
      let layout;
      while (window.companionPhysicsTicks < 400) { layout = await tick(); if (!layout.moving) break; }
      if (layout?.moving) throw new Error('Body motion exceeded twenty seconds of controlled physics');
      return !window.companionState.active || window.companionState.active.index !== index;
    }, index);
  }
}
async function menu(page) { await page.locator('#pet').dispatchEvent('contextmenu', { button: 2 }); await page.locator('#menu').waitFor(); }

test('NPC follows real arrival, pauses typing, resumes retained intent and returns home', async t => {
  const { page, receive, body, configure } = await fixture(t, 'quiet');
  await npcUntil(page, 'outbound');
  const original = await page.evaluate(() => ({ id: window.npcState.walkId, target: window.npcState.target }));
  assert.ok(original.id > 0);
  await page.evaluate(() => { window.npcKeyboard = 'active'; }); await npcTick(page);
  assert.equal(await page.evaluate(() => window.npcState.phase), 'yield');
  assert.equal(await page.evaluate(() => window.npcState.target), original.target);
  await page.waitForFunction(() => document.querySelector('#pet').dataset.mode !== 'walk');
  assert.equal(await page.locator('#companion-invitation').isVisible(), false);
  await page.evaluate(() => { window.npcKeyboard = 'idle'; }); await npcTick(page); await npcTick(page, 5000);
  assert.equal(await page.evaluate(() => window.npcState.walkId), null);
  await npcUntil(page, 'outbound');
  assert.ok(await page.evaluate(id => window.npcState.walkId > id, original.id));
  assert.equal(await page.evaluate(() => window.npcState.target), original.target);
  await body.evaluate(({ id, layout }) => parent.postMessage({ t: 'frame', layout, events: [{ kind: 'arrived', detail: { walkId: id } }] }, '*'), { id: original.id, layout: await page.evaluate(() => window.lastNpcLayout) });
  await page.waitForSelector('#pet[data-mode=walk]');
  await page.waitForFunction(() => window.npcState.phase === 'observe', null, { timeout: 20000 });
  assert.ok(await page.evaluate(() => window.npcState.recent.length > 0));
  await page.screenshot({ path: 'artifacts/npc-life-observe.png' });
  await npcUntil(page, 'return');
  await page.waitForFunction(() => window.npcState.phase === 'home', null, { timeout: 20000 });
  await page.waitForSelector('#pet[data-mode=sit]');
  await page.evaluate(() => { window.npcBodyFrame = document.querySelector('#body-layer iframe'); });
  await configure({ companionship: 'off' }); await page.waitForFunction(() => document.querySelector('#pet').dataset.mode !== 'sit');
  assert.equal(await page.evaluate(() => document.querySelector('#body-layer iframe') === window.npcBodyFrame), true);
  await configure({ companionship: 'quiet' });
  await npcUntil(page, 'outbound');
  const target = await page.evaluate(() => window.npcState.target);
  await receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
  await page.waitForFunction(() => window.npcState.phase === 'yield');
  assert.equal(await page.evaluate(() => window.npcState.target), target);
  assert.equal(await page.locator('#pet').getAttribute('data-mood'), 'working');
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type !== 'presentation')), []);
});

test('invitation reserves once, ignores naturally, persists quiet and cannot send model/task messages', async t => {
  const { page, read, configure } = await fixture(t, 'interactive', ['neutral', 'stand', 'wave', 'love', 'happy', 'nod']);
  await page.evaluate(() => { window.companionRandom = .999; });
  await advanceCompanion(page, 1800000); await page.locator('#companion-invitation').waitFor(); await page.screenshot({ path: 'artifacts/companionship-invitation.png' }); assert.equal((await read()).invitation.remaining, 1);
  const focus = await page.evaluate(() => document.activeElement.tagName);
  await advanceCompanion(page, 1810000); await page.locator('#companion-invitation').waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => document.activeElement.tagName), focus);
  await advanceCompanion(page, await page.evaluate(() => window.companionState.inviteAt)); await page.locator('#companion-invitation').waitFor();
  await page.locator('#companion-quiet').click(); await page.waitForFunction(() => document.querySelector('#companion-status').textContent.length > 0);
  await page.waitForTimeout(150); assert.equal((await read()).invitation.quiet, true);
  await configure({ companionship: 'quiet' }); await configure({ companionship: 'interactive' }); await advanceCompanion(page, 7200000); assert.equal(await page.locator('#companion-invitation').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type !== 'presentation')), []);
});

test('manual play grows only after completion, aborted play does not, archive survives renderer reload', async t => {
  const f = await fixture(t, 'quiet'); const { page, read } = f;
  await menu(page); await page.locator('#companion-play').click(); await page.mouse.move(0, 0); assert.equal((await read()).relation.total, 0);
  await finishActivity(page); await page.waitForFunction(() => document.querySelector('#companion-status').textContent.includes('1'));
  assert.equal((await read()).relation.total, 1);
  assert.ok(await f.body.evaluate(() => window.bodyOrders.some(order => order.t === 'do' && order.word === 'dance')), 'the default long recipe reaches its real body');
  f.setDay(16); await menu(page); await page.locator('#companion-play').click(); await page.mouse.move(0, 0);
  await f.receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
  await advanceCompanion(page, await page.evaluate(() => window.companionNow + 20000)); assert.equal((await read()).relation.total, 1);
  await page.reload(); await page.waitForSelector('#pet[data-mode]');
  await f.receive({ type: 'init', baseline: true, options: { companionship: 'quiet', roam: true }, snapshot: snapshot() });
  await page.waitForFunction(() => document.querySelector('#companion-status').textContent.includes('1'));
  const raw = JSON.parse(await readFile(join(f.directory, 'care/state.json'), 'utf8')); assert.equal(raw.characters.whale.total, 1);
});

test('hot companionship modes preserve captured reader, draft selection, and in-flight identities', async t => {
  const { page, receive, configure } = await fixture(t);
  const result = { id: 'p1-long', sessionId: session.id, text: '## Captured\n\n' + 'Stable reader content.\n\n'.repeat(100), time: 1, read: false };
  await receive({ type: 'snapshot', snapshot: snapshot({ results: [result], sessions: [{ ...session, replyId: result.id, reply: result.text }] }) });
  await receive({ type: 'ui-control', command: 'chat' }); await page.locator('#message').fill('my stable draft'); await page.locator('#message').evaluate(n => n.setSelectionRange(2, 6)); await page.locator('#chat-read').click();
  await page.locator('#reader-text').evaluate(n => { n.scrollTop = 120; window.captured = n.firstChild; });
  const actions = await page.evaluate(() => window.actions.filter(a => a.type !== 'presentation'));
  for (const companionship of ['off', 'quiet', 'interactive']) await configure({ companionship });
  for (const diagnostics of [true, false, true]) await configure({ diagnostics });
  assert.equal(await page.locator('#reader-text').evaluate(n => n.scrollTop === 120 && n.firstChild === window.captured), true);
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type !== 'presentation')), actions);
  await page.keyboard.press('Escape'); await receive({ type: 'ui-control', command: 'chat' }); await page.locator('#message').evaluate(n => n.setSelectionRange(2, 6));
  for (const companionship of ['quiet', 'interactive', 'off']) await configure({ companionship });
  for (const diagnostics of [false, true, false]) await configure({ diagnostics });
  assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n === document.activeElement, n.selectionStart, n.selectionEnd]), ['my stable draft', true, 2, 6]);
  await page.locator('#send').click(); const sent = await page.evaluate(() => window.actions.find(a => a.type === 'chat'));
  await configure({ companionship: 'interactive', diagnostics: true }); await configure({ diagnostics: false }); await receive({ type: 'chat-result', sessionId: sent.sessionId, requestId: sent.requestId, status: 'accepted' });
  assert.equal(await page.locator('#message').inputValue(), ''); assert.equal(await page.evaluate(() => window.actions.filter(a => a.type === 'chat').length), 1);
});

test('real strokes count once, forged sandbox touches do not, missing words remain safe', async t => {
  const { page, read, body } = await fixture(t, 'quiet');
  await page.mouse.move(0, 0);
  await body.evaluate(() => parent.postMessage({ t: 'frame', layout: null, events: [{ kind: 'touch', detail: { kind: 'pet' } }] }, '*'));
  await page.waitForTimeout(100); assert.equal((await read()).relation.total, 0);
  const b = await page.locator('#pet').boundingBox();
  // Cross the real hit region broadly enough to remain a stroke under input jitter.
  for (let i = 0; i < 18; i++) await page.mouse.move(b.x + b.width * (i % 2 ? .2 : .8), b.y + b.height * .45, { steps: 1 });
  await page.waitForFunction(() => document.querySelector('#companion-status').textContent.includes('1'));
  assert.equal((await read()).relation.total, 1);
  const missing = await fixture(t, 'quiet', ['neutral', 'stand']);
  await advanceCompanion(missing.page, 600000); assert.equal(await missing.page.locator('#pet').getAttribute('data-companion-activity'), 'idle');
  const orders = await missing.body.evaluate(() => window.bodyOrders.filter(e => e.t === 'do').map(e => e.word)); assert.deepEqual(orders.filter(w => !['neutral', 'stand'].includes(w)), []);
});

test('twenty manual activities react within 500ms and interrupted trials never grow', async t => {
  const { page, read, receive } = await fixture(t, 'quiet'); const latencies = [];
  for (let i = 0; i < 20; i++) {
    await menu(page);
    await page.locator('#companion-play').evaluate(n => n.addEventListener('click', () => { window.playInputAt = performance.now(); }, { once: true }));
    await page.locator('#companion-play').click();
    await page.waitForSelector('#pet[data-companion-activity=play]'); latencies.push(await page.evaluate(() => performance.now() - window.playInputAt));
    await receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
    await receive({ type: 'snapshot', snapshot: snapshot() });
  }
  assert.ok(latencies.filter(n => n <= 500).length >= 19, JSON.stringify(latencies)); assert.equal((await read()).relation.total, 0);
});

test('twenty real strokes keep visible feedback while hovering and share the growth cooldown', async t => {
  const { page, read, receive } = await fixture(t, 'quiet');
  await page.evaluate(() => {
    window.strokeLatencies = [];
    document.addEventListener('pointermove', () => { window.strokeInputAt = performance.now(); }, { capture: true });
    new MutationObserver(records => {
      if (records.some(r => r.type === 'childList') && !document.querySelector('#companion-feedback').hidden)
        window.strokeLatencies.push(performance.now() - window.strokeInputAt);
    }).observe(document.querySelector('#companion-feedback'), { childList: true });
  });
  for (let trial = 0; trial < 20; trial++) {
    await page.mouse.move(0, 0);
    if (trial) await page.waitForTimeout(2550);
    const b = await page.locator('#pet').boundingBox();
    for (let i = 0; i < 18; i++) await page.mouse.move(b.x + b.width * (i % 2 ? .2 : .8), b.y + b.height * .45, { steps: 1 });
    await page.waitForFunction(n => window.strokeLatencies.length > n, trial);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#companion-feedback').isVisible(), true);
  }
  const latencies = await page.evaluate(() => window.strokeLatencies);
  assert.equal(latencies.length, 20); assert.ok(latencies.filter(n => n <= 500).length >= 19, JSON.stringify(latencies));
  assert.equal((await read()).relation.total, 1);
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type !== 'presentation')), []);
  await receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
  await page.locator('#companion-feedback').waitFor({ state: 'hidden', timeout: 500 });
});


test('six stored moments across three dates unlock the real familiar greeting after rehydration', async t => {
  const f = await fixture(t, 'quiet', ['neutral', 'stand', 'wave', 'love', 'happy', 'nod']); const { page, store, read } = f;
  for (let day = 15; day < 18; day++) for (const minute of [0, 5]) {
    f.setDay(day, minute); const state = await read();
    await store.request({ type: 'play', characterId: 'whale', requestId: `shared-${day}-${minute}`, revision: state.revision });
  }
  assert.equal((await read()).relation.unlocked, true);
  await f.configure({ companionship: 'interactive' });
  await page.waitForFunction(() => document.querySelector('#companion-status').textContent.includes('已解锁'));
  await page.evaluate(() => { window.companionRandom = .999; });
  await advanceCompanion(page, 1800000); await page.locator('#companion-invitation').waitFor();
  await advanceCompanion(page, 1802100); await page.waitForFunction(() => window.companionEvents.some(e => e.word === 'love'));
  assert.ok(await f.body.evaluate(() => window.bodyOrders.some(e => e.t === 'do' && e.word === 'love')));
});

test('reduced motion cancels an in-progress activity and a small large-text menu remains reachable', async t => {
  const { page, configure, read } = await fixture(t, 'quiet');
  await menu(page); await page.locator('#companion-play').click(); await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => window.companionState.active === null, null, { timeout: 1000 });
  assert.equal((await read()).relation.total, 0);
  await page.setViewportSize({ width: 480, height: 400 }); await configure({ textScale: 1.5 });
  await menu(page);
  await page.screenshot({ path: 'artifacts/companionship-small-menu.png' });
  const bounds = await page.locator('#menu').boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 400, JSON.stringify(bounds));
  await page.locator('#hide').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#hide').isVisible(), true);
});

test('idle rendering is bounded while real elapsed time, work and input keep their cadence', async t => {
  const { page, configure, receive, body } = await fixture(t, 'quiet');
  await configure({ roam: false }); await page.mouse.move(0, 0);
  await body.evaluate(() => { window.cadence = []; addEventListener('message', e => { if (e.data?.t === 'tick') window.cadence.push(e.data.dt); }); });
  const sample = async () => { await body.evaluate(() => { window.cadence = []; }); const at = await page.evaluate(() => performance.now()); await page.waitForTimeout(2000); return { elapsed: (await page.evaluate(() => performance.now()) - at) / 1000, ticks: await body.evaluate(() => window.cadence.slice()) }; };
  const idle = await sample();
  await configure({ companionship: 'off' }); const disabled = await sample();
  const hasHeadroom = disabled.ticks.length / disabled.elapsed >= 40;
  assert.ok(idle.ticks.length > 0 && idle.ticks.length / idle.elapsed <= 31, JSON.stringify({ idle, disabled }));
  if (hasHeadroom) assert.ok(idle.ticks.length < disabled.ticks.length * .8 && idle.ticks.length > disabled.ticks.length * .25, JSON.stringify({ idle: idle.ticks.length, disabled: disabled.ticks.length }));
  else t.diagnostic('Renderer baseline is below 40fps; relative speedup is not exercised here. Controlled render-cadence tests cover cap/bypass and dt.');
  if (hasHeadroom) assert.ok(Math.abs(idle.ticks.reduce((a, b) => a + b, 0) - idle.elapsed) < .25, JSON.stringify(idle));
  await configure({ companionship: 'quiet' });
  await receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
  const work = await sample(); assert.ok(work.ticks.length > 0); if (hasHeadroom) assert.ok(work.ticks.length > idle.ticks.length * 1.3);
  await receive({ type: 'snapshot', snapshot: snapshot() }); await receive({ type: 'ui-control', command: 'chat' }); await page.locator('#message').fill('Keep the input cadence');
  const input = await sample(); assert.ok(input.ticks.length > 0); if (hasHeadroom) assert.ok(input.ticks.length > idle.ticks.length * 1.3);
});


test('unknown input, mouse proximity, lifecycle and limited star keep control and vocabulary safe', async t => {
  const f = await fixture(t, 'quiet'); const { page, receive, configure, body } = f;
  await configure({ size: 181 }); await configure({ size: 180 });
  await body.waitForFunction(() => window.bodyOrders.some(o => o.t === 'set' && o.state.bounds?.S === 180 / 256));
  const scale = () => body.evaluate(() => window.bodyOrders.filter(o => o.t === 'set' && o.state.bounds).at(-1)?.state.bounds.S);
  await npcUntil(page, 'outbound');
  const target = await page.evaluate(() => window.npcState.target);
  const box = await page.locator('#pet').boundingBox();
  await page.mouse.move(box.x - 25, box.y + box.height / 2); await npcTick(page);
  assert.equal(await page.evaluate(() => window.npcState.phase), 'yield');
  assert.equal(await page.evaluate(() => window.npcState.target), target);
  await page.mouse.move(0, 0); await page.evaluate(() => { window.npcKeyboard = 'unknown'; }); await npcTick(page);
  assert.equal(await page.locator('#pet').getAttribute('data-npc-reason'), 'unknown');
  assert.equal(await scale(), 180 / 256, 'unknown perception must not shrink the body');
  await page.evaluate(() => { window.npcKeyboard = 'idle'; }); await npcTick(page); await npcTick(page, 5000);
  assert.equal(await scale(), 180 / 256, 'idle recovery must retain configured size');
  const runtime = { phase: 'running', visible: false, suspended: false, generation: 1, visibilityRevision: 1 };
  await receive({ type: 'notification-state', snapshot: { protocol: 1, runtime, interactions: [] } }); await npcTick(page);
  assert.equal(await page.evaluate(() => window.npcState.reason), 'lifecycle');
  assert.equal(await page.locator('#npc-home').isVisible(), false);
  await receive({ type: 'notification-state', snapshot: { protocol: 1, runtime: { ...runtime, visible: true, suspended: true }, interactions: [] } }); await npcTick(page);
  assert.equal(await page.evaluate(() => window.npcState.reason), 'lifecycle');
  await configure({ roam: false }); assert.equal(await page.evaluate(() => window.npcState.walkId), null);
  assert.equal(await page.locator('#npc-home').evaluate(n => getComputedStyle(n).pointerEvents), 'none');
  const star = await fixture(t, 'quiet', undefined, true);
  await star.page.waitForSelector('#pet[data-character=paper-star]');
  for (let i = 0; i < 50; i++) await npcTick(star.page);
  assert.equal(await star.page.evaluate(() => window.npcEvents.some(e => e.walk)), false);
  const words = await star.body.evaluate(() => window.bodyOrders.filter(e => e.t === 'do').map(e => e.word));
  assert.ok(!words.includes('look') && !words.includes('sit') && !words.includes('dance'), JSON.stringify(words));
});


test('native NPC waits for acknowledged workArea before establishing home', async t => {
  const { page, receive } = await fixture(t, 'quiet');
  await page.reload(); await page.waitForSelector('#pet[data-mode]');
  await page.evaluate(() => { window.dshPetBridge.nativeGeometry = true; });
  await receive({ type: 'init', baseline: true, options: { companionship: 'quiet', roam: true }, snapshot: snapshot() });
  for (let i = 0; i < 10; i++) await npcTick(page);
  assert.equal(await page.evaluate(() => window.npcState.placed), false);
  assert.equal(await page.evaluate(() => window.npcState.reason), 'geometry');
  await receive({ type: 'display-changed', revision: 1, displayId: 2, workArea: { x: -1000, y: 0, width: 1000, height: 750 }, contentBounds: { x: -1000, y: 0, width: 1000, height: 750 }, scaleFactor: 2 });
  await npcUntil(page, 'outbound');
  assert.ok(await page.evaluate(() => window.npcEvents.some(e => e.place !== undefined && Math.abs(e.place - 850) < 1)));
});

test('manual interaction survives a frame timestamp preceding the click event clock', async t => {
  // Isolate clock ordering from the longer dance physics at low frame rates.
  const { page, read, configure } = await fixture(t, 'quiet', ['happy', 'nod', 'neutral'], false, { frameLag: 100 });
  await configure({ roam: false });
  await menu(page); await page.locator('#companion-play').click(); await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#pet').getAttribute('data-companion-activity'), 'play', 'A stale frame timestamp must not cancel explicit play');
  assert.equal((await read()).relation.total, 0, 'Starting still does not grant growth');
  await page.waitForFunction(() => document.querySelector('#companion-status').textContent.includes('1'));
  assert.equal((await read()).relation.total, 1);
});

for (const jump of [false, true]) test(`manual interaction follows a real poke reaction while actual work still preempts it (jump=${jump})`, async t => {
  const { page, body, read, receive, configure } = await fixture(t, 'quiet', undefined, false, {});
  await configure({ roam: false });
  await page.waitForFunction(() => window.lastNpcLayout?.mode === 'idle' && !window.lastNpcLayout.busy);
  // The upstream poke randomly jumps. Exercise both real physics paths rather
  // than mistaking the air/crouch guard for a short expression blocking play.
  await body.evaluate(jump => { Math.random = () => jump ? .1 : .9; }, jump);
  await page.locator('#pet').click(); await page.mouse.move(0, 0);
  if (jump) {
    // Admit the action within the observed physical frame, so automation latency
    // cannot turn an airborne attempt into a click after landing.
    await page.waitForFunction(() => {
      if (!['crouch', 'air'].includes(window.lastNpcLayout?.mode)) return false;
      document.querySelector('#companion-play').click();
      return true;
    });
    assert.equal(await page.locator('#pet').getAttribute('data-companion-activity'), 'idle', 'Airborne physics still owns the body');
    assert.equal((await read()).relation.total, 0);
    await page.waitForSelector('#pet[data-mode=idle]');
  } else await page.waitForSelector('#pet[data-mood=happy]');
  await menu(page); await page.locator('#companion-play').click(); await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#pet').getAttribute('data-companion-activity'), 'play', 'A brief poke expression is not task occupancy');
  assert.equal((await read()).relation.total, 0);
  await receive({ type: 'snapshot', snapshot: snapshot({ mood: 'working', active: true, sessions: [{ ...session, mood: 'working', active: true }] }) });
  await page.waitForSelector('#pet[data-companion-activity=idle][data-mood=working]');
  assert.equal((await read()).relation.total, 0, 'Work interruption never grants growth');
});
