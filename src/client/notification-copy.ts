import type { TaskNotice } from '../notification-contract.ts';
import { petLanguage, appStatusBody } from '../../web/locale.js';

const zh = {
  reply: '本轮回复已生成', 'goal-progress': '目标仍在进行中', completed: '目标已完成', approval: '下一步需要你确认', question: '有个问题想问你', error: '任务需要关注',
  stopped: '先停在这里，随时继续', interrupted: '这段任务中断了，陪你回去看看',
  blocked: '任务暂时停下了，看看下一步怎么继续', 'max-tokens': '这次回复到达上限了，看看下一步怎么继续',
  reminder: '刚才那件事，还等你看看', grouped: (count: number) => `有 ${count} 件事，还等你看看`,
};
const en: typeof zh = {
  reply: 'This turn’s reply is ready', 'goal-progress': 'Goal still in progress', completed: 'Goal completed', approval: 'The next step needs your approval', question: 'There is a question for you', error: 'This task needs attention',
  stopped: 'Paused here. Continue whenever you are ready', interrupted: 'This task was interrupted. Let’s look together',
  blocked: 'The task paused. Let’s check the next step', 'max-tokens': 'This reply reached its limit. Let’s check the next step',
  reminder: 'That earlier request is still waiting for you', grouped: count => `${count} requests are still waiting for you`,
};
/** Localize application copy while preserving source identity and user-authored previews exactly. */
export function systemNotificationCopy(notice: TaskNotice, locale = 'zh'): TaskNotice {
  const copy = petLanguage(locale) === 'zh' ? zh : en;
  if (notice.stage === 'reminder') {
    const summary = notice.requestIds.length > 1 ? copy.grouped(notice.requestIds.length) : copy.reminder;
    return { ...notice, title: summary, body: summary };
  }
  const title = copy[notice.category];
  const short = ['stopped', 'interrupted', 'blocked', 'max-tokens'].includes(notice.category);
  return { ...notice, title, body: short ? title : appStatusBody(notice, locale) };
}
