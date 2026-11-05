import { CompletionTracker } from './completion.ts';
import { basename } from 'node:path';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-user-approval';
import { type PendingInteraction, type TaskNotice } from './notification-contract.ts';

export type Mood = 'idle' | 'thinking' | 'talking' | 'working' | 'waiting' | 'happy' | 'error' | 'sleeping';
export interface PetResult { id: string; sessionId: string; text: string; time: number; read: boolean; }
export interface PetSession { id: string; label: string; project: string; cwd: string; prompt: string; createdAt: number; updatedAt: number; mood: Mood; text: string; reply: string; replyId: string; unread: number; revision: number; active: boolean; streaming: boolean; speechId: string; chatAvailable?: boolean; completion?: TaskNotice['category']; }
export interface PetSnapshot { mood: Mood; text: string; sessionId: string | null; revision: number; active: boolean; streaming: boolean; speechId: string; results: PetResult[]; sessions: PetSession[]; }
export interface PetNotice extends Partial<Omit<TaskNotice, 'title' | 'body' | 'sessionId'>> { title: string; body: string; sessionId: string; kind?: 'task' | 'message'; }
interface TaskState { completion: CompletionTracker; ended: number; seq: number; turn: number; active: boolean; finalText?: string; tools: Map<string, string>; approvals: Set<symbol | string>; questions: Set<string>; requests: Set<string>; celebrateUntil: number; stream?: { id: string; revision: number; index: number; text: string; blocks: Map<number, string> }; }
type ObservedSession = Pick<Session, 'id' | 'header'> & Partial<Pick<Session, 'snapshotEvents'>>;
const ready = '准备好了，随时叫我。';

/** Keeps independent task states so background sessions cannot overwrite the selected conversation. */
export class PetModel {
  private sessions = new Map<string, PetSession>();
  private selected: string | null = null;
  private tasks = new Map<string, TaskState>();
  private results = new Map<string, PetResult>();
  constructor(private readonly now: () => number = Date.now) {}

  observe(session: ObservedSession): PetSession | undefined {
    if (session.header.origin === 'subagent') return;
    let item = this.sessions.get(session.id);
    if (!item) {
      // Bound retained presentation state; live Harness sessions remain owned by the host.
      if (this.sessions.size >= 100) {
        const old = [...this.sessions.keys()].find(id => id !== this.selected);
        if (old) this.remove(old);
      }
      const project = session.header.cwd ? basename(session.header.cwd) : '未指定项目';
      item = { id: session.id, label: project, project, cwd: session.header.cwd ?? '', prompt: '', createdAt: session.header.createdAt, updatedAt: session.header.createdAt, mood: 'idle', text: ready, reply: '', replyId: '', unread: 0, revision: 0, active: false, streaming: false, speechId: '' };
      this.sessions.set(session.id, item);
      this.tasks.set(session.id, { completion: new CompletionTracker(), ended: -1, seq: -1, turn: 0, active: false, tools: new Map(), approvals: new Set(), questions: new Set(), requests: new Set(), celebrateUntil: 0 });
      this.selected ??= session.id;
      // Restore identity from public history, without replaying stale task states or notices.
      for (const event of session.snapshotEvents?.() ?? []) this.describe(item, event);
    }
    return item;
  }

  /** Fold history as a read baseline; callers reconcile activity with the live Agent status. */
  restore(session: ObservedSession): void {
    if (!this.observe(session)) return;
    for (const event of session.snapshotEvents?.() ?? []) this.fold(session, event, false);
  }

  private describe(item: PetSession, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return;
    const text = event.data.content.filter(p => p.type === 'text').map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!item.prompt) item.label = Array.from(text).slice(0, 64).join('');
    item.prompt = Array.from(text).slice(0, 160).join(''); item.updatedAt = event.time;
  }

  /** Live chunks are not session events. Keep attempt identity and ordering separate from durable seq. */
  stream(session: ObservedSession, frame: AssistantStreamFrame): boolean {
    const item = this.observe(session);
    if (!item) return false;
    const task = this.tasks.get(item.id)!;
    if (frame.type === 'start') {
      if (frame.turn < task.turn || (frame.turn === task.turn && !task.active && task.seq >= 0) || (task.stream && frame.revision <= task.stream.revision)) return false;
      task.turn = frame.turn; task.active = true;
      task.finalText = undefined;
      task.stream = { id: frame.attemptId, revision: frame.revision, index: -1, text: '', blocks: new Map() };
      item.streaming = true; item.speechId = frame.attemptId;
      if (!task.tools.size && !task.approvals.size) this.present(item, 'thinking', '正在思考…');
      return true;
    }
    const stream = task.stream;
    if (!task.active || !stream || stream.id !== frame.attemptId || stream.revision !== frame.revision || frame.index <= stream.index) return false;
    stream.index = frame.index;
    if (frame.type === 'end') {
      item.streaming = false;
      if (frame.outcome.kind === 'abandoned' && !task.tools.size && !task.approvals.size) this.present(item, 'thinking', '正在重新准备回复…');
      return true;
    }
    const chunk = frame.chunk;
    if (chunk.type === 'text-delta' || (chunk.type === 'block-end' && chunk.block.type === 'text')) {
      if (chunk.type === 'text-delta') stream.blocks.set(chunk.index, ((stream.blocks.get(chunk.index) ?? '') + chunk.text).slice(0, 1200));
      else if (chunk.block.type === 'text') stream.blocks.set(chunk.index, chunk.block.text.slice(0, 1200));
      stream.text = [...stream.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n').slice(0, 1200);
      if (stream.text.trim()) {
        // Live text changes the expression, never the reader's confirmed result.
        if (!task.tools.size && !task.approvals.size) this.present(item, 'talking', '正在组织回复…');
      }
    } else if (chunk.type === 'reasoning-delta' && !stream.text && !task.tools.size && !task.approvals.size) {
      // The pet signals reasoning without exposing private reasoning content.
      this.present(item, 'thinking', '正在思考…');
    }
    return true;
  }

  detached(id: string): void { const task = this.tasks.get(id); if (task) task.stream = undefined; }

  idle(id: string): void {
    const item = this.sessions.get(id), task = this.tasks.get(id);
    if (!item || !task?.active) return;
    task.active = false; task.stream = undefined; task.tools.clear(); task.approvals.clear(); item.streaming = false;
    this.present(item, 'idle', ready);
  }

  /** Keep the user's focus stable when other conversations are created. */
  created(session: Pick<Session, 'id' | 'header'>): boolean {
    const item = this.observe(session);
    if (!item) return false;
    return true;
  }

  /** Baseline already-running agents without replaying old completion notifications. */
  running(session: Pick<Session, 'id' | 'header'>): void {
    const item = this.observe(session);
    if (!item || this.tasks.get(item.id)!.active) return;
    const task = this.tasks.get(item.id)!; task.active = true;
    if (task.requests.size || task.approvals.size) this.present(item, 'waiting', item.text);
    else this.present(item, 'thinking', '正在处理当前会话…');
  }

  private present(item: PetSession, mood: Mood, text: string): void {
    item.active = this.tasks.get(item.id)!.active;
    if (item.mood === mood && item.text === text) return;
    item.mood = mood; item.text = text; item.revision++;
  }

  /** Celebration has a deadline independent of UI refreshes or other sessions. */
  settle(): boolean {
    let changed = false;
    for (const [id, task] of this.tasks) {
      if (!task.celebrateUntil || this.now() < task.celebrateUntil) continue;
      task.celebrateUntil = 0;
      const item = this.sessions.get(id)!;
      if (!task.active && item.mood === 'happy') { delete item.completion; this.present(item, 'idle', ready); changed = true; }
    }
    return changed;
  }

  consume(session: Pick<Session, 'id' | 'header'>, event: SessionEvent): PetNotice | undefined {
    return this.fold(session, event, true);
  }

  private fold(session: Pick<Session, 'id' | 'header'>, event: SessionEvent, live: boolean): PetNotice | undefined {
    const item = this.observe(session);
    if (!item) return;
    const task = this.tasks.get(item.id)!;
    if (event.seq <= task.seq) return;
    task.seq = event.seq;
    this.describe(item, event);
    const completion = task.completion.consume(event);
    if (event.type === 'goal/change' && completion && live) {
      if (!completion.silent || !task.active) this.present(item, completion.mood, completion.text);
      if (completion.clear) delete item.completion; else item.completion = completion.category;
      task.celebrateUntil = completion.mood === 'happy' ? this.now() + 2500 : 0;
      return completion.silent ? undefined : { title: `${item.label} · ${completion.text}`, body: completion.text, sessionId: item.id, kind: 'task', category: completion.category, goal: completion.goal };
    }
    // Late results from a previous turn cannot overwrite a newer turn.
    if ('turn' in event.data && event.data.turn < task.turn) return;
    switch (event.type) {
      case 'turn/start':
        if (event.data.turn <= task.ended) return;
        delete item.completion;
        task.turn = event.data.turn; task.active = true; task.tools.clear(); task.approvals.clear(); task.celebrateUntil = 0;
        task.stream = undefined; task.finalText = undefined; item.streaming = false; item.speechId = ''; item.updatedAt = event.time;
        this.present(item, 'thinking', '让我想一想…'); break;
      case 'step/start':
        task.active = true; task.finalText = undefined;
        if (!task.approvals.size && !task.tools.size) this.present(item, 'thinking', '正在思考…'); break;
      case 'tool/call':
        if (!task.active) break;
        task.tools.set(event.data.callId, event.data.name);
        if (!task.approvals.size) this.present(item, 'working', toolLabel(event.data.name)); break;
      case 'tool/result':
        if (!task.active) break;
        task.tools.delete(event.data.message.toolCallId);
        if (task.approvals.size) break;
        if (task.tools.size) { this.present(item, 'working', toolLabel(task.tools.values().next().value!)); break; }
        if (event.data.message.isError) {
          this.present(item, 'thinking', '这一步遇到了问题，正在处理。');
        } else { this.present(item, 'thinking', '这一步完成了，继续想想…'); }
        break;
      case 'assistant/message': {
        const text = event.data.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (!task.active) break;
        item.streaming = false;
        task.finalText = event.data.message.content.some(p => p.type === 'tool-call') ? undefined : text;
        if (text.trim() && !task.tools.size && !task.approvals.size) this.present(item, 'talking', '正在组织回复…');
        break;
      }
      case 'approval/asked': {
        const notice = this.approval(item.id, event.data.toolName, event.data.id);
        return live ? notice : undefined;
      }
      case 'approval/decided':
        this.approvalSettled(item.id, event.data.id); break;
      case 'turn/end': {
        if (event.data.turn <= task.ended) return;
        task.ended = event.data.turn;
        task.turn = event.data.turn; task.active = false; task.tools.clear(); task.approvals.clear(); task.celebrateUntil = 0;
        task.stream = undefined; item.streaming = false;
        switch (event.data.reason.kind) {
          case 'completed': {
            const text = task.finalText?.trim() ? task.finalText : '';
            if (text) {
              const id = `${item.id}:${event.data.turn}:${event.seq}`;
              this.results.set(id, { id, sessionId: item.id, text, time: event.time, read: !live });
              item.reply = text; item.replyId = id; if (live) item.unread++;
              // Retain complete text for the latest 200 results, preferring unread entries.
              if (this.results.size > 200) {
                const old = [...this.results.values()].find(r => r.read) ?? this.results.values().next().value!;
                this.results.delete(old.id);
                const owner = this.sessions.get(old.sessionId); if (owner && !old.read) owner.unread--;
              }
            }
            task.finalText = undefined;
            const outcome = completion!;
            item.completion = outcome.category;
            this.present(item, live ? outcome.mood : 'idle', live ? outcome.text : ready); task.celebrateUntil = live && outcome.mood === 'happy' ? this.now() + 2500 : 0;
            return live ? { title: `${item.label} · ${outcome.text}`, body: text.slice(0, 180) || outcome.text, sessionId: item.id, kind: 'task', category: outcome.category, goal: outcome.goal } : undefined;
          }
          case 'error':
            this.present(item, 'error', '任务遇到了问题，请回到 Harness 查看详情。');
            return live ? { title: `${item.label} · 需要关注`, body: item.text, sessionId: item.id, kind: 'task' } : undefined;
          case 'blocked':
          case 'max-tokens':
            this.present(item, 'waiting', '任务暂时停下了，请回到 Harness 看看。');
            return live ? { title: `${item.label} · 任务暂停`, body: item.text, sessionId: item.id, kind: 'task' } : undefined;
          case 'aborted':
            this.present(item, 'idle', '先停在这里，随时继续。');
            return live ? { title: `${item.label} · 任务已停止`, body: item.text, sessionId: item.id, kind: 'task', category: 'stopped' } : undefined;
          case 'interrupted':
            this.present(item, 'waiting', '这段任务中断了，陪你回去看看。');
            return live ? { title: `${item.label} · 任务中断`, body: item.text, sessionId: item.id, kind: 'task', category: 'interrupted' } : undefined;
          default:
            this.present(item, 'idle', '准备好了，随时叫我。');
        }
      }
    }
  }

  approval(id: string, tool: string, token: symbol | string = Symbol()): PetNotice | undefined {
    const item = this.sessions.get(id);
    if (!item) return;
    const task = this.tasks.get(id)!; task.active = true; task.approvals.add(token); task.celebrateUntil = 0;
    this.present(item, 'waiting', `${toolLabel(tool)}前需要你确认，请回到 Harness。`);
    return { title: `${item.label} · 等你确认`, body: item.text, sessionId: id, kind: 'task' };
  }

  approvalSettled(id: string, token?: symbol | string): void {
    const item = this.sessions.get(id);
    const task = this.tasks.get(id);
    if (!item || !task?.active) return;
    if (token ? !task.approvals.delete(token) : !task.approvals.size) return;
    if (!token) task.approvals.clear();
    if (!task.approvals.size && item.mood === 'waiting') {
      this.present(item, task.tools.size ? 'working' : 'thinking', task.tools.size ? toolLabel(task.tools.values().next().value!) : '确认已处理，等待任务继续…');
    }
  }

  /** Public request state can outlive a turn; viewing or reading never removes its waiting entrance. */
  interactions(values: readonly PendingInteraction[]): void {
    for (const [id, task] of this.tasks) {
      const wasPending = task.requests.size > 0;
      const pending = values.filter(value => value.sessionId === id && value.state !== 'settled');
      task.requests = new Set(pending.map(value => value.id));
      task.questions = new Set(pending.filter(value => value.kind === 'question').map(value => value.id));
      const item = this.sessions.get(id)!;
      if (pending.length) {
        delete item.completion;
        task.celebrateUntil = 0;
        this.present(item, 'waiting', pending.some(value => value.kind === 'question') ? '有个问题想问你，请回到 Harness 看看。' : '下一步需要你确认，请回到 Harness。');
      } else if (wasPending && !task.approvals.size && item.mood === 'waiting') {
        this.present(item, task.active ? task.tools.size ? 'working' : 'thinking' : 'idle', task.active ? task.tools.size ? toolLabel(task.tools.values().next().value!) : '等待任务继续…' : ready);
      }
    }
  }

  select(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.selected = id; return true;
  }

  /** Acknowledging an older result cannot clear a newer completion. */
  read(id: string): boolean {
    const result = this.results.get(id);
    if (!result || result.read) return false;
    result.read = true;
    const item = this.sessions.get(result.sessionId); if (item) item.unread = Math.max(0, item.unread - 1);
    return true;
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.tasks.delete(id);
    for (const [key, result] of this.results) if (result.sessionId === id) this.results.delete(key);
    if (this.selected === id) this.selected = this.sessions.keys().next().value ?? null;
  }

  snapshot(): PetSnapshot {
    const item = this.selected ? this.sessions.get(this.selected) : undefined;
    this.settle();
    return { mood: item?.mood ?? 'idle', text: item?.text ?? ready, sessionId: item?.id ?? null, revision: item?.revision ?? 0, active: item?.active ?? false, streaming: item?.streaming ?? false, speechId: item?.speechId ?? '', results: [...this.results.values()].map(r => ({ ...r })), sessions: [...this.sessions.values()].map(s => ({ ...s })) };
  }
}

function toolLabel(name: string): string {
  if (/read|cat|view/.test(name)) return '正在看文件';
  if (/search|grep|find/.test(name)) return '正在查找';
  if (/write|edit|patch/.test(name)) return '正在写代码';
  if (/bash|shell|exec|terminal/.test(name)) return '正在运行命令';
  if (/web|browse|fetch/.test(name)) return '正在浏览';
  return `正在使用 ${name.slice(0, 60)}`;
}
