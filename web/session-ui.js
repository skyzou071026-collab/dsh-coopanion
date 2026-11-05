/** Strip the uninformative host prefix and extend IDs only when necessary to distinguish them. */
export function shortSessionIds(sessions) {
  const ids = sessions.map(s => s.id.replace(/^session[-_:]/, '') || s.id);
  return new Map(sessions.map((session, i) => {
    let length = Math.min(6, ids[i].length);
    while (length < ids[i].length && ids.some((id, j) => j !== i && id.slice(0, length) === ids[i].slice(0, length))) length++;
    return [session.id, ids[i].slice(0, length)];
  }));
}

import { petCopy, petLanguage } from './locale.js';
export function sessionTime(session, locale = 'zh') {
  const time = session.updatedAt || session.createdAt;
  return time ? new Intl.DateTimeFormat(petLanguage(locale) === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : petCopy(locale).timeUnknown;
}

/** Attention entries carry their own source; inspecting them never changes chat focus. */
export function inboxContents(snapshot, interactions = [], acknowledged = new Set()) {
  const requests = interactions.filter(item => item.state !== 'settled');
  const requested = new Set(requests.map(item => item.sessionId));
  const issues = (snapshot.sessions ?? []).filter(session => session.mood === 'error' || session.mood === 'waiting' && !requested.has(session.id));
  const replies = unreadReplies(snapshot, acknowledged);
  return { requests, issues, replies, total: requests.length + issues.length + replies.length };
}

/** Keep one latest reply per source, with the exact unread identities it represents. */
export function unreadReplies(snapshot, acknowledged = new Set()) {
  const sources = new Map();
  for (const result of snapshot.results ?? []) {
    if (result.read || acknowledged.has(result.id)) continue;
    const current = sources.get(result.sessionId);
    const unreadIds = current?.unreadIds ?? [];
    unreadIds.push(result.id);
    // Results are retained in completion order; the later entry wins a timestamp tie.
    sources.set(result.sessionId, { ...(current && current.time > result.time ? current : result), unreadIds });
  }
  return [...sources.values()].sort((a, b) => b.time - a.time);
}

/** One focus for chat, one aggregate signal for work happening elsewhere. */
export function sessionActivity(snapshot) {
  const sessions = snapshot.sessions ?? [];
  const waiting = sessions.filter(s => s.mood === 'waiting');
  const errors = sessions.filter(s => s.mood === 'error');
  const unread = snapshot.results ? new Set(snapshot.results.filter(result => !result.read).map(result => result.sessionId)).size : sessions.filter(s => s.unread).length;
  const busy = sessions.filter(s => s.active ?? ['thinking', 'talking', 'working'].includes(s.mood));
  const focusedActive = snapshot.active ?? ['thinking', 'talking', 'working'].includes(snapshot.mood);
  const background = sessions.filter(s => s.id !== snapshot.sessionId);
  const pending = background.filter(s => s.unread || ['waiting', 'error'].includes(s.mood));
  const fallback = errors[0]?.mood ?? waiting[0]?.mood ?? busy[0]?.mood;
  const mood = focusedActive || ['waiting', 'error', 'happy'].includes(snapshot.mood) ? snapshot.mood : fallback ?? snapshot.mood ?? 'idle';
  return { mood, active: focusedActive || busy.length > 0, waiting: waiting.length, errors: errors.length, unread, busy: busy.length, pending: pending.length,
    icon: errors.length ? 'error' : waiting.length ? 'waiting' : mood === 'idle' && unread ? 'unread' : mood };
}

/** Per-session drafts and immutable attempts. A timeout is uncertain delivery, so retry keeps its ID. */
export class ChatComposer {
  constructor({ id = () => crypto.randomUUID(), timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) { this.id = id; this.timeZone = timeZone; this.sessions = new Map(); }
  state(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { text: '', phase: 'idle' });
    return this.sessions.get(sessionId);
  }
  edit(sessionId, text) { const state = this.state(sessionId); if (state.phase === 'accepted') { state.phase = 'idle'; state.request = undefined; } state.text = text; }
  begin(sessionId) {
    const state = this.state(sessionId), text = state.text.trim();
    if (!text || text.length > 2000 || state.phase === 'sending') return;
    if (!state.request || state.request.text !== text) state.request = Object.freeze({ type: 'chat', sessionId, requestId: this.id(), text, clientTimeZone: this.timeZone() });
    state.phase = 'sending'; state.code = undefined;
    return state.request;
  }
  receive(receipt) {
    if (!chatReceipt(receipt)) return false;
    const state = this.sessions.get(receipt.sessionId);
    if (!state?.request || state.request.requestId !== receipt.requestId) return false;
    // Acceptance is monotonic: a late timeout/failure cannot undo it.
    if (state.phase === 'accepted') return false;
    state.phase = receipt.status; state.code = receipt.code;
    if (receipt.status === 'accepted' && state.text.trim() === state.request.text) state.text = '';
    return true;
  }
  expire(request) { return this.receive({ type: 'chat-result', sessionId: request.sessionId, requestId: request.requestId, status: 'failed', code: 'coopanion/no-receipt' }); }
}
import { chatReceipt } from './chat-contract.js';

/** Runtime-only viewing receipts; task facts and actual approval/question requests remain authoritative. */
export class SessionAttention {
  constructor() { this.seen = new Map(); }
  key(session) { return JSON.stringify([session.mood, session.revision ?? 0, session.text ?? '', session.completion ?? '']); }
  acknowledge(snapshot, interactions, id) {
    const session = snapshot.sessions?.find(s => s.id === id);
    if (!session || session.active || !['error', 'waiting'].includes(session.mood) || interactions.some(item => item.sessionId === id && item.state !== 'settled')) return false;
    this.seen.set(id, this.key(session));
    return true;
  }
  project(snapshot, interactions = []) {
    if (!this.seen.size) return snapshot;
    const sources = new Map((snapshot.sessions ?? []).map(s => [s.id, s]));
    const requested = new Set(interactions.filter(item => item.state !== 'settled').map(item => item.sessionId));
    for (const [id, key] of this.seen) {
      const session = sources.get(id);
      if (!session || session.active || requested.has(id) || this.key(session) !== key) this.seen.delete(id);
    }
    if (!this.seen.size) return snapshot;
    const selectedViewed = this.seen.has(snapshot.sessionId);
    return { ...snapshot, ...(selectedViewed ? { mood: 'idle' } : {}), sessions: snapshot.sessions.map(s => this.seen.has(s.id) ? { ...s, mood: 'idle' } : s) };
  }
}
