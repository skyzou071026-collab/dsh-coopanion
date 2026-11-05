import { petLanguage, appStatusBody } from './locale.js';
/** Pure presentation policy; request truth and delivery selection remain owned by Host. */
const messages = {
  zh: {
    reply: '本轮回复已生成。', 'goal-progress': '本轮回复已生成，目标仍在进行中。', completed: '目标完成啦，要看看结果吗？', approval: '下一步需要你确认。', question: '有个问题想问你。',
    error: '遇到一点问题，陪你回去看看。', stopped: '先停在这里，随时继续。', interrupted: '这段任务中断了，陪你回去看看。',
    blocked: '任务暂时停下了，看看下一步怎么继续。', 'max-tokens': '这次回复到达上限了，看看下一步怎么继续。',
    reminder: '刚才那件事，还等你看看。', grouped: n => `有 ${n} 件事，还等你看看。`,
    pending: '等你的一点小事', empty: '都处理好啦，安心做手边的事。', open: '回到源会话 ↗', snooze: '稍后提醒', snoozing: '正在安排…', close: '先收起来', replies: '查看会话与未读回复',
    approvalLabel: '需要确认', questionLabel: '有个问题', continued: '仍可回答', delay: '下次提醒', unavailable: '这件事已处理或暂时无法安排提醒。',
    inboxTitle: '给你带回来了', inboxCaption: '回复与待办', inbox: '收件箱 ↩', newReply: '新回复', readReply: '展开全文', continue: '继续对话 ↗', handle: '去处理 ↗', errorLabel: '需要关注', waitingLabel: '任务暂停', replyCaption: '捎回来的回复', previous: '上一份回复', next: '下一份回复',
    inboxSummary: (replies, pending) => `${pending} 件待处理 · ${replies} 份未读回复`, focus: label => `正在聊：${label}`, inboxEmpty: '都看过啦，安心做手边的事。',
  },
  en: {
    reply: 'This turn’s reply is ready.', 'goal-progress': 'This turn’s reply is ready. The goal is still in progress.', completed: 'Goal completed. Shall we look at the result?', approval: 'The next step needs your approval.', question: 'There is a question for you.',
    error: 'Something went wrong. Let’s look together.', stopped: 'Paused here. Continue whenever you are ready.', interrupted: 'This task was interrupted. Let’s look together.',
    blocked: 'The task paused. Let’s check the next step.', 'max-tokens': 'This reply reached its limit. Let’s check the next step.',
    reminder: 'That earlier request is still waiting for you.', grouped: n => `${n} requests are still waiting for you.`,
    pending: 'A few things waiting for you', empty: 'All taken care of. Carry on with your work.', open: 'Open source session ↗', snooze: 'Remind me later', snoozing: 'Scheduling…', close: 'Put away for now', replies: 'Sessions and unread replies',
    approvalLabel: 'Approval needed', questionLabel: 'A question for you', continued: 'You can still answer', delay: 'Next reminder', unavailable: 'This request was handled or a reminder cannot be scheduled yet.',
    inboxTitle: 'Brought back for you', inboxCaption: 'Replies and requests', inbox: 'Inbox ↩', newReply: 'New reply', readReply: 'Read full reply', continue: 'Continue conversation ↗', handle: 'Take a look ↗', errorLabel: 'Needs attention', waitingLabel: 'Task paused', replyCaption: 'A reply for you', previous: 'Previous reply', next: 'Next reply',
    inboxSummary: (replies, pending) => `${pending} to handle · ${replies} unread replies`, focus: label => `Chatting with: ${label}`, inboxEmpty: 'All read. Carry on with your work.',
  },
};
export function notificationCopy(locale = 'zh') { return messages[petLanguage(locale)]; }
export function pendingInteractions(snapshot) { return (snapshot?.interactions ?? []).filter(item => item.state !== 'settled'); }
export function notificationPresentation(notice, locale, words = []) {
  const copy = notificationCopy(locale);
  const title = notice.stage === 'reminder' ? notice.requestIds.length > 1 ? copy.grouped(notice.requestIds.length) : copy.reminder : copy[notice.category] ?? notice.title;
  const mood = { reply: 'idle', 'goal-progress': 'idle', completed: 'happy', approval: 'waiting', question: 'waiting', error: 'error', stopped: 'idle', interrupted: 'waiting', blocked: 'waiting', 'max-tokens': 'waiting' }[notice.category] ?? 'idle';
  const candidates = notice.stage === 'reminder' ? ['wave', 'worried', 'neutral'] : {
    completed: ['happy', 'wave', 'neutral'], approval: ['worried', 'thinking', 'neutral'], question: ['curious', 'thinking', 'worried', 'neutral'],
    error: ['sad', 'worried', 'neutral'], stopped: ['nod', 'neutral'], interrupted: ['confused', 'worried', 'neutral'], blocked: ['worried', 'thinking', 'neutral'], 'max-tokens': ['worried', 'thinking', 'neutral'],
  }[notice.category] ?? ['neutral'];
  return { title, body: appStatusBody(notice, locale), mood, word: candidates.find(word => words.includes(word)) };
}
/** Bounded queue: input, reading and drag hold presentation while the inbox remains available. */
export function createNoticeQueue({ limit = 32, history = 256 } = {}) {
  const pending = [], seen = new Set();
  return {
    push(notice) {
      if (!notice?.id || seen.has(notice.id)) return false;
      seen.add(notice.id); while (seen.size > history) seen.delete(seen.values().next().value);
      pending.push(notice); if (pending.length > limit) pending.shift(); return true;
    },
    next(blocked, interactions) {
      if (blocked) return undefined;
      while (pending.length) {
        const notice = pending.shift();
        // An authoritative state can settle a queued prompt before the user finishes reading.
        if (notice.requestIds.length && interactions && !notice.requestIds.some(id => interactions.some(item => item.id === id && item.state !== 'settled'))) continue;
        return notice;
      }
    },
    discard(predicate) { for (let i = pending.length - 1; i >= 0; i--) if (predicate(pending[i])) pending.splice(i, 1); },
    clear() { pending.length = 0; },
    get size() { return pending.length; },
  };
}
