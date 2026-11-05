import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';

const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-ui-'));
const server = previewServer({ dataDir: directory }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
const source = 'session-full-question-abcdef-123456';
const interactionId = JSON.stringify([source, 'question', 'native-call-full']);
const request = { id: interactionId, nativeId: 'native-call-full', sessionId: source, kind: 'question', turn: 1, seq: 2, createdAt: 1, preview: '<img src=x onerror="throw 1"> Which option?', state: 'continued', dueAt: Date.now() + 600000, automaticReminders: 0 };
const state = { protocol: 1, runtime: { phase: 'running', visible: true, generation: 7, visibilityRevision: 4, suspended: false }, interactions: [request] };
const notice = (id, category = 'question', stage = 'initial', requestIds = [interactionId]) => ({ id, sessionId: source, category, stage, turn: 1, seq: 2, time: Date.now(), title: 'Question', body: request.preview, requestIds });
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.n2Actions = [];
    window.dshPetBridge = { subscribe(fn) { window.n2Receive = fn; }, action(action) { window.n2Actions.push(action); }, hit() {} };
  });
  const receive = message => page.evaluate(message => window.n2Receive(message), message);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-character=whale][data-mode]');
  await receive({ type: 'init', options: { locale: 'en-US', reminders: true, bubbleDurationMs: 60000 }, snapshot: { mood: 'idle', sessionId: 'selected-other-session', sessions: [{ id: 'selected-other-session', label: 'Reading task', mood: 'idle', chatAvailable: true }, { id: source, label: 'Question source', mood: 'idle' }], results: [] } });
  await receive({ type: 'notification-state', snapshot: state });
  await receive({ type: 'notice', notice: notice('initial') });
  await page.locator('#interaction:not([hidden])').waitFor();
  assert.equal(await page.locator('#interaction-title').innerText(), 'There is a question for you.');
  assert.equal(await page.locator('#interaction-preview img').count(), 0, 'question preview is text, never HTML');
  assert.equal(await page.locator('#chat-session-name').innerText(), 'Reading task', 'a question never changes selected chat session');
  await page.locator('#interaction-pending').click();
  assert.equal(await page.locator('.request-card').count(), 1);
  assert.match(await page.locator('.request-card').innerText(), /You can still answer/);
  await page.locator('[data-action=snooze]').click();
  assert.deepEqual((await page.evaluate(() => window.n2Actions)).find(action => action.type === 'notification-snooze'), { type: 'notification-snooze', interactionId, generation: 7 });
  assert.equal(await page.locator('[data-action=snooze]').isDisabled(), true, 'snooze waits for Host confirmation');
  await receive({ type: 'notification-snooze-result', interactionId, ok: false });
  assert.equal(await page.locator('[data-action=snooze]').isDisabled(), false);
  assert.match(await page.locator('#request-feedback').innerText(), /cannot be scheduled/);
  await page.locator('[data-action=open]').click();
  assert.ok((await page.evaluate(() => window.n2Actions)).some(action => action.type === 'open-session' && action.sessionId === source));
  assert.ok(!(await page.evaluate(() => window.n2Actions)).some(action => ['read', 'answered', 'approved'].includes(action.type)), 'view/open/snooze cannot answer or approve a request');

  // A final reply being read has precedence over a reminder, including continued questions.
  const reply = { id: 'reply-full', sessionId: 'selected-other-session', time: 1, text: 'Full reply. '.repeat(40), read: false };
  await receive({ type: 'snapshot', snapshot: { mood: 'happy', sessionId: reply.sessionId, sessions: [{ id: reply.sessionId, label: 'Reading task', mood: 'happy', unread: 1, replyId: reply.id, chatAvailable: true }, { id: source, label: 'Question source', mood: 'idle' }], results: [reply] } });
  await page.locator('#bubble-expand').click();
  await receive({ type: 'notice', notice: notice('reading-reminder', 'question', 'reminder') });
  await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false);
  assert.equal(await page.locator('#reader-text').innerText(), reply.text.trim());
  await page.keyboard.press('Escape'); await page.locator('#interaction:not([hidden])').waitFor();
  assert.equal(await page.locator('#interaction-title').innerText(), 'That earlier request is still waiting for you.');
  await page.locator('#interaction-close').click();

  // Chat input holds a prompt. A request settling during that wait must never replay.
  await receive({ type: 'ui-control', command: 'chat' }); await page.locator('#message').fill('I am typing');
  await receive({ type: 'notice', notice: notice('typing-reminder', 'question', 'reminder') });
  await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false); assert.equal(await page.locator('#message').inputValue(), 'I am typing');
  await receive({ type: 'notification-state', snapshot: { ...state, interactions: [{ ...request, state: 'settled', dueAt: null }] } });
  await page.keyboard.press('Escape'); await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false);

  // Grouped reminders and Chinese copy, plus keyboard-discoverable request inbox.
  const second = { ...request, id: 'approval-full', nativeId: 'approval-full', kind: 'approval', preview: 'Run command?', state: 'open' };
  await receive({ type: 'configure', options: { locale: 'zh-CN' } });
  await receive({ type: 'notification-state', snapshot: { ...state, interactions: [request, second] } });
  await receive({ type: 'notice', notice: notice('grouped', 'question', 'reminder', [interactionId, second.id]) });
  await page.locator('#interaction:not([hidden])').waitFor(); assert.equal(await page.locator('#interaction-title').innerText(), '有 2 件事，还等你看看。');
  await page.locator('#interaction-pending').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('.request-card').count(), 2);
  assert.match(await page.locator('.request-card').first().innerText(), /仍可回答/);
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/notification-pending-requests.png' });
  await page.keyboard.press('Escape');

  // Stale runtime generations remove queued and visible prompts without touching unread replies.
  await receive({ type: 'notice', notice: notice('generation-notice') }); await page.locator('#interaction:not([hidden])').waitFor();
  await receive({ type: 'notification-state', snapshot: { ...state, runtime: { ...state.runtime, generation: 8 } } });
  assert.equal(await page.locator('#interaction').isVisible(), false);
  await receive({ type: 'notification-state', snapshot: { ...state, runtime: { ...state.runtime, generation: 8, visible: false } } });
  await receive({ type: 'notice', notice: notice('hidden-notice') }); await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false);
  await receive({ type: 'notification-state', snapshot: { ...state, runtime: { ...state.runtime, generation: 8 } } });
  await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false, 'hidden-channel messages are not replayed after show');
  const box = await page.locator('#pet').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 25, { steps: 5 });
  await page.waitForFunction(() => document.getElementById('pet').dataset.mode === 'drag');
  await receive({ type: 'notice', notice: notice('drag-notice') });
  await page.waitForTimeout(100); assert.equal(await page.locator('#interaction').isVisible(), false, 'drag holds character prompts');
  await page.mouse.up(); await page.locator('#interaction:not([hidden])').waitFor();
  await page.locator('#interaction-close').click();

  // Installed Host dispatches a completion notice before its final-result snapshot.
  const completed = notice('completion-before-result', 'completed', 'initial', []);
  completed.turn = 2; completed.seq = 3;
  await receive({ type: 'snapshot', snapshot: { mood: 'thinking', sessionId: source, sessions: [{ id: source, mood: 'thinking', label: 'Completion source' }], results: [] } });
  await receive({ type: 'notice', notice: completed });
  await page.locator('#interaction:not([hidden])').waitFor();
  const final = { id: `${source}:2:3`, sessionId: source, time: 2, text: 'The installed final reply.', read: false };
  const finalSnapshot = { mood: 'happy', sessionId: source, sessions: [{ id: source, mood: 'happy', label: 'Completion source', replyId: final.id, unread: 1 }], results: [final] };
  await receive({ type: 'snapshot', snapshot: finalSnapshot });
  await page.waitForFunction(() => !document.getElementById('bubble').hidden && document.getElementById('bubble-text').textContent === 'The installed final reply.', undefined, { timeout: 3000 });
  assert.equal(await page.locator('#interaction').isVisible(), false, 'the final reply owns focused completion presentation');
  await page.locator('#dismiss').click();
  await receive({ type: 'notice', notice: { ...completed, id: 'completion-after-result' } });
  assert.equal(await page.locator('#interaction').isVisible(), false, 'the reverse arrival order does not produce a second completion prompt');

  // Round replies and active-goal replies remain readable, without success reactions.
  for (const [category, title] of [['reply', '本轮回复已生成。'], ['goal-progress', '本轮回复已生成，目标仍在进行中。']]) {
    const middle = { ...completed, id: `m1-${category}`, category, turn: 5, seq: category === 'reply' ? 8 : 9, body: 'Full intermediate reply, preserved verbatim.' };
    await receive({ type: 'notice', notice: middle });
    await page.locator('#interaction:not([hidden])').waitFor();
    assert.equal(await page.locator('#interaction-title').innerText(), title);
    await page.waitForFunction(() => document.querySelector('#pet').dataset.mood === 'idle');
    await page.locator('#interaction-close').click();
    const middleReply = { id: `${source}:${middle.turn}:${middle.seq}`, sessionId: source, time: 5, text: middle.body, read: false };
    await receive({ type: 'snapshot', snapshot: { ...finalSnapshot, mood: 'idle', sessions: [{ id: source, mood: 'idle', completion: category, label: 'Goal source', unread: 1 }], results: [middleReply] } });
    await page.locator('#bubble:not([hidden])').waitFor();
    assert.equal(await page.locator('#bubble-text').innerText(), middle.body);
    await page.locator('#dismiss').click();
    await receive({ type: 'notice', notice: { ...middle, id: middle.id + '-late' } });
    assert.equal(await page.locator('#interaction').isVisible(), false, 'late round notices cannot duplicate an existing full reply');
    await page.screenshot({ path: `artifacts/m1-${category}.png` });
  }

  // An unrelated prompt expiring must release a waiting reply without another Host update.
  await receive({ type: 'configure', options: { bubbleDurationMs: 2000 } });
  await receive({ type: 'notice', notice: notice('expires-before-reply', 'error', 'initial', []) });
  await page.locator('#interaction:not([hidden])').waitFor();
  await page.mouse.move(0, 0);
  const waiting = { ...final, id: `${source}:3:5`, text: 'Reply released after prompt expiry.' };
  await receive({ type: 'snapshot', snapshot: { ...finalSnapshot, results: [final, waiting] } });
  await page.waitForFunction(() => !document.getElementById('bubble').hidden && document.getElementById('bubble-text').textContent === 'Reply released after prompt expiry.', undefined, { timeout: 4000 });
  assert.deepEqual(errors, []);
  console.log('Notification UI passed: full source/request identity, Host-confirmed snooze, text previews, continued request inbox, reading/input/drag protection, settlement race, grouped bilingual prompts, reduced motion and generation/visibility cleanup.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
