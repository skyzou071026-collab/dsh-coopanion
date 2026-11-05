import { it, expect } from 'vitest';
import { createSpeech, replyPreview } from '../web/speech.js';
import { shortSessionIds, sessionActivity, inboxContents, SessionAttention } from '../web/session-ui.js';
import tray from '../desktop/tray-state.cjs';

it('resolves native language before the first Host configuration arrives', () => {
  expect(tray.trayLocale(undefined, {}, ['zh-CN'])).toBe('zh');
  expect(tray.trayLocale(undefined, {}, ['fr-FR','en-US'])).toBe('en');
  expect(tray.trayLocale({ locale:'en' }, { locale:'zh' }, ['zh-CN'])).toBe('en');
  expect(tray.trayLocale({ locale:null }, { locale:'zh' }, ['en-US'])).toBe('zh');
});

it('uses the Harness language for native tray labels and preserves user session titles', () => {
  const snapshot = { sessionId:'locale-source',mood:'thinking',active:true,sessions:[{id:'locale-source',label:'用户的中文会话',mood:'thinking',active:true}] };
  const state = tray.trayState(snapshot, {}, { locale:'en' }, true);
  expect(state.stateLabel).toBe('Thinking');
  expect(state.tooltip).toContain('Focused: 用户的中文会话');
  expect(state.sessionLabel).toBe('用户的中文会话');
});

it('keeps the visible Unicode prefix and punctuation pause when live speech is extended', () => {
  const node = { textContent: '' }, spoken = [];
  const speech = createSpeech({ text: '你好，', node, onCharacter: ch => spoken.push(ch) });
  speech.step(.1); expect(node.textContent).toBe('你好');
  expect(speech.update('你好，🐳继续')).toBe(true); expect(node.textContent).toBe('你好');
  speech.step(.05); expect(node.textContent).toBe('你好，');
  speech.step(.1); expect(node.textContent).toBe('你好，');
  speech.step(.3); expect(node.textContent).toBe('你好，🐳继续');
  expect(spoken).toEqual(['你', '好', '🐳', '继', '续']);
  expect(speech.update('另一段')).toBe(false);
});

it('distinguishes host IDs with the same session prefix and collision-prone first six characters', () => {
  const ids = shortSessionIds([{ id: 'session-abcdef-111' }, { id: 'session-abcdef-222' }, { id: 'session-987654321' }]);
  expect(new Set(ids.values()).size).toBe(3);
  expect([...ids.values()].every(id => !id.startsWith('session-'))).toBe(true);
});

it('projects selected session, appearance, visibility and preferences into the macOS status bar', () => {
  const snapshot = { sessionId: 'b', mood: 'talking', active: true, sessions: [{ id: 'a', label: '菜单' }, { id: 'b', label: '修复同步', mood: 'talking' }] };
  const state = tray.trayState(snapshot, { characterId: 'whale', scheme: 'harness', name: '大肥鱼', sleeping: true, sound: false }, { locale: 'zh', roam: false, notifications: false }, true);
  expect(state).toMatchObject({ sessionId: 'b', sessionLabel: '修复同步', mood: 'talking', title: '', icon: 'talking', sleeping: false, characterId: 'whale', scheme: 'harness', visible: true, roam: false, notifications: false, sound: false });
  expect(state.sessions.map(s => s.selected)).toEqual([true, false]);
  expect(state.tooltip).toContain('正在回复');
  expect(tray.trayState({ ...snapshot, mood: 'idle', active: false, sessions: [] }, { sleeping: true })).toMatchObject({ title: '', icon: 'sleeping' });
});

it('bounds preview typing time while preserving full Unicode text for the reader', () => {
  const full = '一句完整的话。\n' + '🐳很长很长，'.repeat(900) + '最后一句';
  const preview = replyPreview(full);
  expect(preview.long).toBe(true); expect(Array.from(preview.text).length).toBeLessThanOrEqual(181);
  expect(preview.text).not.toMatch(/[\uD800-\uDBFF]$/);
  const node = { textContent: '' };
  const speech = createSpeech({ text: preview.text, node, onCharacter: () => {} });
  for (let n = 0; n < 62; n++) speech.step(.05);
  expect(speech.done).toBe(true); expect(node.textContent).toBe(preview.text);
  expect(full.endsWith('最后一句')).toBe(true);
});

it('shares background attention and active work between the character and tray without changing focus', () => {
  const snapshot = { sessionId: 'a', mood: 'thinking', active: true, sessions: [{ id: 'a', mood: 'thinking', active: true }, { id: 'b', mood: 'waiting', active: true, unread: 2 }, { id: 'c', mood: 'idle', unread: 1 }] };
  expect(sessionActivity(snapshot)).toMatchObject({ mood: 'thinking', icon: 'waiting', waiting: 1, unread: 2, busy: 2, pending: 2 });
  const state = tray.trayState(snapshot);
  expect(state.activity).toEqual(sessionActivity(snapshot)); expect(state.sessionId).toBe('a');
  expect(tray.trayState({ ...snapshot, mood: 'idle', active: false, sessions: snapshot.sessions.slice(1) }, { sleeping: true })).toMatchObject({ mood: 'waiting', sleeping: false });
});

it('coalesces unread turns by exact session identity without mutating retained history', () => {
  const results = [
    { id: 'b:1', sessionId: 'b', time: 3, read: false, text: 'other session' },
    { id: 'a:2', sessionId: 'a', time: 2, read: false, text: 'newest' },
    { id: 'a:1', sessionId: 'a', time: 1, read: false, text: 'oldest, delivered out of order' },
    { id: 'a:3', sessionId: 'a', time: 2, read: false, text: 'later completion at the same timestamp' },
    { id: 'a:0', sessionId: 'a', time: 0, read: true, text: 'already read' },
  ];
  const snapshot = { results, sessions: [{ id: 'a', unread: 3 }, { id: 'b', unread: 1 }] };
  const contents = inboxContents(snapshot);
  expect(contents.replies.map(reply => reply.id)).toEqual(['b:1', 'a:3']);
  expect(contents.replies[1].unreadIds).toEqual(['a:2', 'a:1', 'a:3']);
  expect(contents.total).toBe(2); expect(sessionActivity(snapshot).unread).toBe(2);
  expect(inboxContents(snapshot, [], new Set(contents.replies[1].unreadIds)).replies.map(reply => reply.id)).toEqual(['b:1']);
  expect(results.filter(result => !result.read)).toHaveLength(4);
  expect(results.every(result => !('unreadIds' in result))).toBe(true);
  expect(tray.trayState(snapshot).activity.unread).toBe(2);
});

import { notificationCopy, notificationPresentation, createNoticeQueue } from '../web/notification-ui.js';
const taskNotice = (id, category = 'question', stage = 'initial', requestIds = ['question-full']) => ({ id, sessionId: 'session-full', category, stage, title: 'Title', body: 'Full question preview', requestIds });
it('maps every event and grouped reminder into character language with supported vocabulary fallback', () => {
  for (const category of ['completed', 'approval', 'question', 'error', 'stopped', 'interrupted', 'blocked', 'max-tokens']) {
    const zh = notificationPresentation(taskNotice(category, category), 'zh-CN', ['neutral']);
    const en = notificationPresentation(taskNotice(category, category), 'en-US', []);
    expect(zh.word).toBe('neutral'); expect(en.word).toBeUndefined(); expect(zh.title).not.toBe(en.title); expect(en.body).toBe('Full question preview');
  }
  expect(notificationPresentation(taskNotice('reminder', 'question', 'reminder', ['a', 'b']), 'en', ['worried'])).toMatchObject({ title: '2 requests are still waiting for you.', word: 'worried', mood: 'waiting' });
  expect(notificationCopy('zh-TW').open).toContain('源会话');
});
it('holds deduplicated character prompts during reading and drops settled requests before presentation', () => {
  const queue = createNoticeQueue({ limit: 2 });
  queue.push(taskNotice('one')); expect(queue.push(taskNotice('one'))).toBe(false);
  expect(queue.next(true, [])).toBeUndefined(); expect(queue.size).toBe(1);
  expect(queue.next(false, [{ id: 'question-full', state: 'settled' }])).toBeUndefined();
  queue.push(taskNotice('two')); queue.push(taskNotice('three')); queue.push(taskNotice('four'));
  expect(queue.size).toBe(2); expect(queue.next(false, undefined).id).toBe('three');
  queue.clear(); expect(queue.next(false)).toBeUndefined();
});

it('uses round, progress and goal success categories consistently in role and native tray copy', async () => {
  const { notificationPresentation } = await import('../web/notification-ui.js');
  for (const [category, mood, fragment] of [['reply', 'idle', 'reply is ready'], ['goal-progress', 'idle', 'still in progress'], ['completed', 'happy', 'Goal completed']]) {
    const role = notificationPresentation({ category, stage: 'initial', body: 'Unchanged user result', requestIds: [] }, 'en', ['happy','neutral']);
    expect(role.mood).toBe(mood); expect(role.title).toContain(fragment); expect(role.body).toBe('Unchanged user result');
    const selected = { id: 'full', label: '用户标题', mood, completion: category, active: false };
    const state = tray.trayState({ sessionId: selected.id, mood, sessions: [selected] }, {}, { locale: 'en' });
    expect(state.stateLabel).toContain(fragment); expect(state.mood).toBe(mood);
  }
});

it('viewing a generic issue suppresses only that exact revision without changing task facts or other unread work', () => {
  const attention = new SessionAttention();
  const source = { id: 'a', mood: 'error', revision: 1, text: 'failed', active: false };
  const snapshot = { sessionId: 'a', mood: 'error', active: false, sessions: [source, { ...source, id: 'b' }], results: [{ id: 'reply', sessionId: 'b', read: false, time: 1 }] };
  expect(attention.acknowledge(snapshot, [], 'a')).toBe(true);
  const projected = attention.project(snapshot);
  expect(projected.sessions[0].mood).toBe('idle');
  expect(inboxContents(projected)).toMatchObject({ issues: [{ id: 'b' }], total: 2 });
  expect(sessionActivity(projected).mood).toBe('error');
  expect(source.mood).toBe('error');
  const next = { ...snapshot, sessions: [{ ...source, revision: 2 }] };
  expect(inboxContents(attention.project(next)).issues).toHaveLength(1);
});
it('view receipts cannot settle requests, hide active work, or survive a removed/recreated session', () => {
  const attention = new SessionAttention();
  const source = { id: 'a', mood: 'waiting', revision: 1, active: false };
  const snapshot = { sessionId: 'a', mood: 'waiting', sessions: [source] };
  const request = { id: 'request', sessionId: 'a', state: 'open' };
  expect(attention.acknowledge(snapshot, [request], 'a')).toBe(false);
  expect(attention.acknowledge({ ...snapshot, sessions: [{ ...source, active: true }] }, [], 'a')).toBe(false);
  attention.acknowledge(snapshot, [], 'a');
  expect(attention.project(snapshot, [request]).mood).toBe('waiting');
  attention.acknowledge(snapshot, [], 'a'); attention.project({ ...snapshot, sessions: [] });
  expect(attention.project(snapshot).mood).toBe('waiting');
});

it('discarding a viewed queued notice preserves deduplication and the order of other requests', () => {
  const queue = createNoticeQueue();
  const viewed = taskNotice('viewed', 'error', 'initial', []);
  const request = taskNotice('request');
  queue.push(viewed); queue.push(request);
  queue.discard(notice => notice.id === viewed.id);
  expect(queue.push(viewed)).toBe(false);
  expect(queue.next(false).id).toBe(request.id);
  const next = taskNotice('new-error', 'error', 'initial', []);
  expect(queue.push(next)).toBe(true); expect(queue.next(false).id).toBe(next.id);
});
