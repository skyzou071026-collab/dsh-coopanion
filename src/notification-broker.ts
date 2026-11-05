import { CompletionTracker } from './completion.ts';
import { randomUUID } from 'node:crypto';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-user-approval';
import {
  NOTIFICATION_PROTOCOL, deliveryReceiptSchema, interactionId, noticeId, noticeSchema,
  notificationPreferencesSchema, runtimeSchema,
  type DeliveryClaim, type DeliveryReceipt, type NotificationPreferences,
  type NotificationRuntime, type NotificationSnapshot, type PendingInteraction, type TaskNotice,
} from './notification-contract.ts';

export type NotificationEvent = SessionEvent | { type: 'tool/ptc-dispatch'; data: { name: string; subCallId: string; turn?: number }; seq: number; time: number };
type SourceSession = Pick<Session, 'id' | 'header'> & Partial<Pick<Session, 'snapshotEvents'>>;
export interface QuestionProjection {
  active: readonly { callId: string; state: 'open' | 'continued'; questions: readonly { question: string }[] }[];
  settled?: readonly { callId: string }[];
}
export interface LiveQuestion {
  nativeId: string; turn: number; seq: number; preview: string; signal?: AbortSignal; source?: 'event' | 'runtime';
}
export interface BrokerClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface BrokerOptions {
  clock?: BrokerClock;
  /** Must synchronously enqueue into the acknowledged native generation, or return false. */
  presentRole?(notice: TaskNotice, runtime: NotificationRuntime): boolean;
  changed?(): void;
  token?(): string;
  claimDurationMs?: number;
  clientLifetimeMs?: number;
}
type SourceKind = 'event' | 'runtime';
type SourcedNotice = TaskNotice & { source?: SourceKind };
interface RequestState extends PendingInteraction { source?: SourceKind; projected: boolean; snoozes: number; cleanup?: () => void; }
interface QuestionOrigin { turn: number; seq: number; time: number; }
interface SourceState { completion: CompletionTracker; ended: number; seq: number; turn: number; finalText: string; label: string; calls: Map<string, QuestionOrigin>; }
interface Delivery {
  notice: TaskNotice; state: 'pending' | 'claimed' | DeliveryReceipt['state'] | 'role' | 'cancelled';
  claim?: DeliveryClaim; requested: boolean; receipts: DeliveryReceipt[];
}
const realClock: BrokerClock = {
  now: Date.now,
  setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const title: Record<TaskNotice['category'], string> = {
  reply: '本轮回复已生成', 'goal-progress': '目标仍在进行中', completed: '目标已完成', approval: '等你确认', question: '有个问题想问你', error: '需要关注',
  stopped: '先停在这里', interrupted: '任务中断了', blocked: '任务暂时停下了', 'max-tokens': '输出达到上限',
};
const body: Record<TaskNotice['category'], string> = {
  reply: '本轮回复已生成，回到会话查看。', 'goal-progress': '本轮回复已生成，目标仍在进行中。', completed: '目标已完成，回到会话查看。', approval: '下一步需要你确认。', question: '有个问题想问你。', error: '任务遇到了问题，陪你回去看看。',
  stopped: '先停在这里，随时继续。', interrupted: '这段任务中断了，陪你回去看看。', blocked: '看看下一步怎么继续。', 'max-tokens': '看看下一步怎么继续。',
};

/** Event truth, reminder scheduling and delivery ownership stay in the Host. Views never settle requests. */
export class NotificationBroker {
  private readonly clock: BrokerClock;
  private prefs = notificationPreferencesSchema.parse({});
  private run: NotificationRuntime = { phase: 'stopped', generation: 0, visibilityRevision: 0, visible: false, suspended: false };
  private readonly sources = new Map<string, SourceState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly clients = new Map<string, number>();
  private readonly problems: { code: string; sessionId: string; nativeId: string }[] = [];
  private timer?: unknown;
  private closed = false;
  constructor(private readonly options: BrokerOptions = {}) { this.clock = options.clock ?? realClock; }

  snapshot(): NotificationSnapshot {
    return { protocol: NOTIFICATION_PROTOCOL, runtime: { ...this.run }, interactions: [...this.requests.values()].filter(r => r.state !== 'settled').map(r => this.publicRequest(r)) };
  }
  /** Bounded diagnostics; a requested receipt alone never means the OS displayed a notification. */
  diagnostics(): { code: string; sessionId: string; nativeId: string }[] { return this.problems.map(p => ({ ...p })); }
  history(): { notice: TaskNotice; state: Delivery['state']; receipts: DeliveryReceipt[] }[] {
    return [...this.deliveries.values()].map(d => ({ notice: structuredClone(d.notice), state: d.state, receipts: d.receipts.map(r => ({ ...r })) }));
  }
  preferences(value: Partial<NotificationPreferences>): void {
    const delayChanged = value.reminderDelayMs !== undefined && value.reminderDelayMs !== this.prefs.reminderDelayMs;
    this.prefs = notificationPreferencesSchema.parse({ ...this.prefs, ...value });
    if (!this.prefs.reminders) for (const delivery of this.deliveries.values()) if (delivery.notice.stage === 'reminder') this.cancel(delivery);
    if (!this.prefs.notifications) this.cancelDeliveries();
    for (const request of this.requests.values()) {
      if (request.state === 'settled') continue;
      if (!this.prefs.notifications || !this.prefs.reminders) request.dueAt = null;
      else if ((request.dueAt === null || delayChanged) && request.automaticReminders === 0) request.dueAt = this.clock.now() + this.prefs.reminderDelayMs;
    }
    this.refresh();
  }
  runtime(value: NotificationRuntime): boolean {
    const next = runtimeSchema.parse(value);
    if (next.phase === 'running' && this.run.phase === 'running' && next.generation === this.run.generation && next.visibilityRevision === this.run.visibilityRevision && next.visible !== this.run.visible) return false;
    if (this.closed || next.generation < this.run.generation || (next.generation === this.run.generation && next.visibilityRevision < this.run.visibilityRevision)) return false;
    const generationChanged = next.generation !== this.run.generation;
    const changed = next.generation !== this.run.generation || next.visibilityRevision !== this.run.visibilityRevision || next.phase !== this.run.phase || next.suspended !== this.run.suspended;
    if (changed) for (const delivery of this.deliveries.values()) {
      if (next.generation === this.run.generation && next.phase === 'running' && !next.suspended && !delivery.claim && delivery.state === 'pending') { delivery.state = 'pending'; delivery.claim = undefined; }
      else this.cancel(delivery);
    }
    this.run = next;
    if (next.phase !== 'running' || generationChanged) for (const r of this.requests.values()) r.dueAt = null;
    if (next.phase === 'running') for (const r of this.requests.values()) if (r.state !== 'settled' && r.automaticReminders === 0 && r.dueAt === null && this.prefs.reminders && this.prefs.notifications) r.dueAt = this.clock.now() + this.prefs.reminderDelayMs;
    this.refresh(); return true;
  }

  /** Baseline history folds pending state; it never replays proactive initial or reminder notices. */
  restore(session: SourceSession, questions?: QuestionProjection): void {
    if (session.header.origin === 'subagent' || this.sources.has(session.id)) return;
    this.source(session);
    for (const event of session.snapshotEvents?.() ?? []) this.event(session, event, false);
    if (questions) this.questions(session, questions, false);
    this.refresh();
  }
  consume(session: SourceSession, event: NotificationEvent): void {
    if (this.closed || session.header.origin === 'subagent') return;
    this.event(session, event, true); this.refresh();
  }
  private source(session: SourceSession): SourceState {
    let state = this.sources.get(session.id);
    if (!state) {
      if (this.sources.size >= 100) this.remove(this.sources.keys().next().value!);
      state = { completion: new CompletionTracker(), ended: -1, seq: -1, turn: 0, finalText: '', calls: new Map(), label: session.header.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '会话' };
      this.sources.set(session.id, state);
    }
    return state;
  }
  private event(session: SourceSession, event: NotificationEvent, live: boolean): void {
    const source = this.source(session);
    if (event.seq <= source.seq) return;
    source.seq = event.seq;
    const completion = source.completion.consume(event as SessionEvent);
    if (event.type === 'goal/change' && completion && !completion.silent && live) {
      this.enqueue({ ...this.notice(session.id, source.turn, event.seq, event.time, completion.category, completion.text), goal: completion.goal });
    }
    // Request settlements from older turns remain meaningful and use exact native identity.
    if (event.type === 'approval/decided') { this.settle(interactionId(session.id, 'approval', event.data.id)); return; }
    if (event.type === 'user/message') {
      const reply = event.data.source as { kind: string; callId?: string };
      if (reply.kind === 'user-question-reply' && reply.callId) { this.settle(interactionId(session.id, 'question', reply.callId)); return; }
    }
    if ('turn' in event.data && event.data.turn !== undefined && event.data.turn < source.turn) return;
    switch (event.type) {
      case 'turn/start': if (event.data.turn <= source.ended) break; source.turn = event.data.turn; source.finalText = ''; break;
      case 'tool/call':
        if (event.data.name === 'ask_user_question') this.origin(source, event.data.callId, event.data.turn, event.seq, event.time);
        break;
      case 'tool/ptc-dispatch':
        if (event.data.name === 'ask_user_question') this.origin(source, event.data.subCallId, source.turn, event.seq, event.time);
        break;
      case 'assistant/message':
        source.finalText = event.data.message.content.some(p => p.type === 'tool-call') ? '' : event.data.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n'); break;
      case 'approval/asked':
        this.open(session.id, 'approval', event.data.id, source.turn, event.seq, event.time, `${event.data.toolName}: ${event.data.reason ?? body.approval}`, false, live); break;
      case 'turn/end': {
        if (event.data.turn <= source.ended) break;
        source.ended = event.data.turn;
        source.turn = event.data.turn;
        if (event.data.reason.kind === 'forked') break;
        const category: TaskNotice['category'] = completion?.category ?? (event.data.reason.kind === 'aborted' ? 'stopped' : event.data.reason.kind);
        if (live) this.enqueue({ ...this.notice(session.id, source.turn, event.seq, event.time, category, source.finalText && event.data.reason.kind === 'completed' ? source.finalText : completion?.text ?? body[category]), ...(completion?.goal ? { goal: completion.goal } : {}) });
        source.finalText = '';
        // Approvals are enclosed by a turn. Durable continued questions are independently projected.
        for (const r of this.requests.values()) if (r.sessionId === session.id && r.kind === 'approval' && r.turn <= source.turn) this.settle(r.id);
        break;
      }
    }
  }
  /** Public projection is authoritative for timed questions, including continued questions after turn/end. */
  questions(session: SourceSession, projection: QuestionProjection, live = true): void {
    if (this.closed || session.header.origin === 'subagent') return;
    const source = this.source(session), active = new Set<string>();
    for (const question of projection.active) {
      const id = interactionId(session.id, 'question', question.callId); active.add(id);
      let origin = source.calls.get(question.callId);
      if (!origin) {
        const events = session.snapshotEvents?.() ?? [];
        const event = events.map(event => event as NotificationEvent).findLast(event => (event.type === 'tool/call' && event.data.callId === question.callId && event.data.name === 'ask_user_question') || (event.type === 'tool/ptc-dispatch' && event.data.subCallId === question.callId && event.data.name === 'ask_user_question'));
        if (event) {
          const start = events.findLast(prior => prior.type === 'turn/start' && prior.seq < event.seq);
          const turn = 'turn' in event.data && event.data.turn !== undefined ? event.data.turn : start?.type === 'turn/start' ? start.data.turn : 0;
          origin = { turn, seq: event.seq, time: event.time };
        }
      }
      const existing = this.requests.get(id);
      if (!origin && existing) origin = { turn: existing.turn, seq: existing.seq, time: existing.createdAt };
      if (!origin) {
        if (!this.problems.some(p => p.sessionId === session.id && p.nativeId === question.callId)) this.problems.push({ code: 'question-source-unavailable', sessionId: session.id, nativeId: question.callId });
        if (this.problems.length > 100) this.problems.shift();
        continue;
      }
      this.open(session.id, 'question', question.callId, origin.turn, origin.seq, origin.time, question.questions.map(q => q.question).join('\n'), true, live, question.state);
    }
    for (const r of this.requests.values()) if (r.sessionId === session.id && r.projected && !active.has(r.id)) this.settle(r.id);
    for (const q of projection.settled ?? []) this.settle(interactionId(session.id, 'question', q.callId));
    this.refresh();
  }
  private origin(source: SourceState, id: string, turn: number, seq: number, time: number): void {
    source.calls.set(id, { turn, seq, time });
    if (source.calls.size > 200) source.calls.delete(source.calls.keys().next().value!);
  }
  /** Observe a runtime blocking request without claiming the answerer chain. */
  question(session: SourceSession, question: LiveQuestion): () => void {
    if (this.closed || session.header.origin === 'subagent' || question.signal?.aborted) return () => {};
    this.source(session);
    const id = interactionId(session.id, 'question', question.nativeId);
    this.open(session.id, 'question', question.nativeId, question.turn, question.seq, this.clock.now(), question.preview, false, true, 'open', question.source);
    const request = this.requests.get(id);
    if (!request) {
      this.problems.push({ code: 'request-capacity-exceeded', sessionId: session.id, nativeId: question.nativeId });
      if (this.problems.length > 100) this.problems.shift();
      return () => {};
    }
    const finish = () => { if (!request.projected) this.settle(id); this.refresh(); };
    question.signal?.addEventListener('abort', finish, { once: true });
    request.cleanup?.(); request.cleanup = () => question.signal?.removeEventListener('abort', finish);
    this.refresh(); return finish;
  }
  private open(sessionId: string, kind: PendingInteraction['kind'], nativeId: string, turn: number, seq: number, time: number, preview: string, projected: boolean, live: boolean, state: 'open' | 'continued' = 'open', sourceKind?: SourceKind): void {
    const id = interactionId(sessionId, kind, nativeId), existing = this.requests.get(id);
    if (existing) { if (existing.state !== 'settled') { existing.state = state; existing.projected ||= projected; existing.preview = preview.slice(0, 2048); } return; }
    if (this.requests.size >= 500) {
      const old = [...this.requests.values()].find(r => r.state === 'settled');
      if (old) this.requests.delete(old.id); else return;
    }
    // Restored requests keep their entrance, with no repeat automatic reminder on reload.
    const request: RequestState = { id, nativeId, sessionId, kind, turn, seq, createdAt: time, preview: preview.slice(0, 2048), state, dueAt: live && this.prefs.notifications && this.run.phase === 'running' && this.prefs.reminders ? this.clock.now() + this.prefs.reminderDelayMs : null, automaticReminders: live ? 0 : 1, projected, snoozes: 0, ...(sourceKind ? { source: sourceKind } : {}) };
    this.requests.set(id, request);
    if (live) {
      const notice = this.notice(sessionId, turn, seq, time, kind, request.preview, [id]) as SourcedNotice;
      if (sourceKind) notice.source = sourceKind;
      if (sourceKind === 'runtime') notice.id = this.identity(notice, 0, nativeId);
      this.enqueue(notice);
    }
  }
  private settle(id: string): void {
    const request = this.requests.get(id); if (!request || request.state === 'settled') return;
    request.state = 'settled'; request.dueAt = null; request.cleanup?.(); request.cleanup = undefined;
    for (const delivery of this.deliveries.values()) {
      if (!delivery.notice.requestIds.includes(id) || delivery.requested || ['role', 'cancelled'].includes(delivery.state)) continue;
      if (delivery.claim) { this.cancel(delivery); continue; }
      delivery.notice.requestIds = delivery.notice.requestIds.filter(key => key !== id && this.requests.get(key)?.state !== 'settled');
      if (!delivery.notice.requestIds.length) delivery.state = 'cancelled';
      else this.cancel(delivery); // A changed group invalidates any previously claimed payload.
    }
  }
  snooze(id: string, generation: number): boolean {
    const request = this.requests.get(id);
    if (!this.eligible() || generation !== this.run.generation || !this.prefs.reminders || !request || request.state === 'settled') return false;
    for (const delivery of this.deliveries.values()) if (!delivery.requested && delivery.notice.requestIds.includes(id) && ['pending', 'claimed'].includes(delivery.state)) this.cancel(delivery);
    request.dueAt = this.clock.now() + this.prefs.reminderDelayMs; request.snoozes++; this.refresh(); return true;
  }

  /** A live client poll refreshes its bounded liveness record and can own one eligible notice. */
  claim(clientId: string, generation: number, noticeId?: string): DeliveryClaim | null {
    if (!clientId || clientId.length > 2048 || this.closed || generation !== this.run.generation) return null;
    this.clients.set(clientId, this.clock.now());
    if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value!);
    this.tick();
    if (!this.eligible() || this.run.visible || !this.prefs.systemNotifications) return null;
    if ([...this.deliveries.values()].some(d => d.claim?.clientId === clientId && ['claimed', 'requested'].includes(d.state))) return null;
    const delivery = [...this.deliveries.values()].find(d => d.state === 'pending' && this.valid(d.notice) && (noticeId === undefined || d.notice.id === noticeId));
    if (!delivery) return null;
    const claim: DeliveryClaim = { token: this.options.token?.() ?? randomUUID(), clientId, generation, visibilityRevision: this.run.visibilityRevision, expiresAt: this.clock.now() + (this.options.claimDurationMs ?? 15_000), notice: structuredClone(delivery.notice) };
    delivery.state = 'claimed'; delivery.claim = claim;
    this.refresh(); return structuredClone(claim);
  }
  receipt(value: DeliveryReceipt): boolean {
    const parsed = deliveryReceiptSchema.safeParse(value); if (!parsed.success || this.closed) return false;
    const receipt = parsed.data, delivery = this.deliveries.get(receipt.noticeId), claim = delivery?.claim;
    if (!delivery || !claim || claim.token !== receipt.token || claim.clientId !== receipt.clientId || claim.generation !== receipt.generation || delivery.state === 'cancelled') return false;
    if (receipt.state === 'requested') {
      // A claim grants one channel once. Late reports only add evidence; they never authorize another delivery.
      if (!['claimed', 'unknown'].includes(delivery.state) || delivery.requested) return false;
      delivery.requested = true;
    } else if (receipt.state === 'failed') {
      if (!['claimed', 'requested', 'shown', 'unknown'].includes(delivery.state)) return false;
    } else {
      if (!delivery.requested || delivery.state === 'failed' || delivery.state === 'clicked') return false;
      if (receipt.state === 'unknown' && delivery.state !== 'requested') return false;
      if (receipt.state === 'shown' && !['requested', 'unknown'].includes(delivery.state)) return false;
      if (receipt.state === 'clicked' && !['requested', 'shown', 'unknown'].includes(delivery.state)) return false;
    }
    delivery.state = receipt.state;
    if (delivery.receipts.length < 5) delivery.receipts.push({ ...receipt });
    this.refresh(); return true;
  }
  private eligible(): boolean { return !this.closed && this.prefs.notifications && this.run.phase === 'running' && this.run.visibilityRevision > 0 && !this.run.suspended; }
  private valid(notice: TaskNotice): boolean { return !notice.requestIds.length || notice.requestIds.some(id => this.requests.get(id)?.state !== 'settled' && this.requests.has(id)); }
  private notice(sessionId: string, turn: number, seq: number, time: number, category: TaskNotice['category'], preview: string, requestIds: string[] = [], stage: TaskNotice['stage'] = 'initial'): TaskNotice {
    return noticeSchema.parse({ id: noticeId(sessionId, turn, seq, category, stage), sessionId, turn, seq, time, category, stage, title: `${this.sources.get(sessionId)?.label ?? '会话'} · ${title[category]}`.slice(0, 256), body: preview.slice(0, 2048), requestIds });
  }
  private identity(notice: TaskNotice, occurrence = 0, runtimeId?: string): string {
    return noticeId(notice.sessionId, notice.turn, notice.seq, notice.category, notice.stage, occurrence, runtimeId);
  }
  private enqueue(notice: TaskNotice): void {
    if (!this.eligible() || this.deliveries.has(notice.id)) return;
    this.deliveries.set(notice.id, { notice, state: 'pending', requested: false, receipts: [] });
    if (this.deliveries.size > 300) {
      const old = [...this.deliveries.entries()].find(([, d]) => d.state !== 'claimed' && d.state !== 'requested');
      if (old) this.deliveries.delete(old[0]);
    }
  }
  private cancel(delivery: Delivery): void {
    if (delivery.claim && !['shown', 'clicked', 'failed'].includes(delivery.state)) delivery.state = 'unknown';
    else if (!delivery.claim && delivery.state !== 'role') delivery.state = 'cancelled';
  }
  private cancelDeliveries(): void { for (const d of this.deliveries.values()) this.cancel(d); }
  /** Callbacks always recompute request truth immediately before creating or dispatching a notice. */
  tick(): void {
    if (this.closed) return;
    const now = this.clock.now();
    for (const [id, time] of this.clients) if (now - time >= (this.options.clientLifetimeMs ?? 30_000)) this.clients.delete(id);
    for (const delivery of this.deliveries.values()) {
      if (!delivery.claim || !['claimed', 'requested'].includes(delivery.state)) continue;
      if (delivery.claim.expiresAt > now && this.clients.has(delivery.claim.clientId)) continue;
      delivery.state = 'unknown';
    }
    if (this.eligible() && this.prefs.reminders) {
      const groups = new Map<string, RequestState[]>();
      for (const request of this.requests.values()) if (request.state !== 'settled' && request.dueAt !== null && request.dueAt <= now) {
        const group = groups.get(request.sessionId) ?? []; group.push(request); groups.set(request.sessionId, group);
      }
      for (const [sessionId, requests] of groups) for (let start = 0; start < requests.length; start += 100) {
        const group = requests.slice(start, start + 100);
        const origin = group[0], notice = this.notice(sessionId, origin.turn, origin.seq, now, origin.kind, group.length > 1 ? `还有 ${group.length} 件事等你看看。` : '刚才那件事，还等你看看。', group.map(r => r.id), 'reminder');
        // Source seq remains literal; a snooze occurrence has its own stable scheduling identity.
        const occurrence = Math.max(...group.map(r => r.snoozes));
        if (origin.source === 'runtime') {
          (notice as SourcedNotice).source = 'runtime'; notice.id = this.identity(notice, occurrence, origin.nativeId);
        } else if (occurrence) notice.id = this.identity(notice, occurrence);
        for (const request of group) { request.dueAt = null; request.automaticReminders = 1; }
        this.enqueue(notice);
      }
    }
    if (this.eligible() && this.run.visible) for (const delivery of this.deliveries.values()) {
      if (delivery.state !== 'pending' || !this.valid(delivery.notice)) continue;
      const state = { ...this.run };
      try { if (this.options.presentRole?.(structuredClone(delivery.notice), state)) delivery.state = 'role'; } catch { delivery.state = 'failed'; }
    }
  }
  private refresh(): void {
    this.tick();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.closed) {
      const due = this.eligible() ? [...this.requests.values()].flatMap(r => r.dueAt === null ? [] : [r.dueAt]) : [];
      for (const d of this.deliveries.values()) if (d.claim && ['claimed', 'requested'].includes(d.state)) due.push(Math.min(d.claim.expiresAt, (this.clients.get(d.claim.clientId) ?? this.clock.now()) + (this.options.clientLifetimeMs ?? 30_000)));
      if (due.length) this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.refresh(); }, Math.max(1, Math.min(...due) - this.clock.now()));
      try { this.options.changed?.(); } catch { /* A view failure cannot escape into Harness dispatch. */ }
    }
  }
  private publicRequest(r: RequestState): PendingInteraction {
    const { projected: _projected, snoozes: _snoozes, cleanup: _cleanup, ...value } = r; return { ...value };
  }
  remove(sessionId: string): void {
    this.sources.delete(sessionId);
    for (const [id, r] of this.requests) if (r.sessionId === sessionId) { r.cleanup?.(); this.requests.delete(id); }
    for (const [id, d] of this.deliveries) if (d.notice.sessionId === sessionId) this.deliveries.delete(id);
    this.refresh();
  }
  dispose(): void {
    this.closed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const r of this.requests.values()) r.cleanup?.();
    this.cancelDeliveries(); this.clients.clear(); this.sources.clear(); this.requests.clear(); this.deliveries.clear(); this.problems.length = 0;
  }
}
