// src/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { SessionId as SessionId2 } from "@deepseek-ai/dsh-session";

// src/completion.ts
import { applyGoalProjection, goalProjectionDefinition } from "@deepseek-ai/dsh-goal";
var reply = { category: "reply", mood: "idle", text: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002" };
var CompletionTracker = class {
  state = goalProjectionDefinition.init();
  turn = 0;
  open = false;
  ended = -1;
  startSeq = -1;
  completeSeq = -1;
  announced = "";
  consume(event) {
    if (event.type === "goal/change" || event.type === "user/message" && event.data.source.kind === "goal") {
      this.state = applyGoalProjection(this.state, event);
      if (event.type === "goal/change" && !this.state.failure) {
        if (event.data.operation === "complete") this.completeSeq = event.seq;
        if (!this.open || event.data.operation === "clear") {
          if (["complete", "block", "pause"].includes(event.data.operation)) return this.decision(event.seq);
          if (event.data.operation === "clear") return { ...reply, text: "\u51C6\u5907\u597D\u4E86\uFF0C\u968F\u65F6\u53EB\u6211\u3002", silent: true, clear: true };
          return { ...this.decision(event.seq), text: "\u76EE\u6807\u72B6\u6001\u5DF2\u66F4\u65B0\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002", silent: true };
        }
      }
    }
    if (event.type === "turn/start" && event.data.turn > this.turn && event.data.turn > this.ended) {
      this.turn = event.data.turn;
      this.open = true;
      this.startSeq = event.seq;
    }
    if (event.type !== "turn/end" || event.data.turn < this.turn || event.data.turn <= this.ended) return;
    this.turn = event.data.turn;
    this.ended = event.data.turn;
    this.open = false;
    if (event.data.reason.kind !== "completed") return;
    return this.decision(event.seq);
  }
  decision(seq) {
    const current = this.state.failure ? null : this.state.current;
    if (!current) return { ...reply };
    const goal = { id: current.goal.id, revision: current.goal.revision, round: current.roundsStarted };
    if (current.goal.phase === "active") return { category: "goal-progress", mood: "idle", text: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u76EE\u6807\u4ECD\u5728\u8FDB\u884C\u4E2D\u3002", goal };
    if (current.goal.phase === "paused") return { category: "stopped", mood: "idle", text: "\u76EE\u6807\u5DF2\u6682\u505C\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002", goal };
    if (current.goal.phase === "blocked") return { category: "blocked", mood: "waiting", text: "\u76EE\u6807\u9047\u5230\u963B\u788D\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002", goal };
    const identity = JSON.stringify([goal.id, goal.revision]);
    if (this.completeSeq >= this.startSeq && this.completeSeq <= seq && this.announced !== identity) {
      this.announced = identity;
      return { category: "completed", mood: "happy", text: "\u76EE\u6807\u5DF2\u5B8C\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002", goal };
    }
    return { ...reply };
  }
};

// src/notification-broker.ts
import { randomUUID } from "node:crypto";

// src/notification-contract.ts
import { z } from "zod";
var NOTIFICATION_PROTOCOL = 1;
var id = z.string().min(1).max(2048);
var counter = z.number().int().nonnegative().safe();
var notificationPreferencesSchema = z.object({
  notifications: z.boolean().default(true),
  systemNotifications: z.boolean().default(false),
  reminders: z.boolean().default(true),
  reminderDelayMs: z.number().int().min(6e4).max(864e5).default(6e5)
}).strict();
var noticeSchema = z.object({
  id,
  sessionId: id,
  turn: counter,
  seq: counter,
  time: counter,
  category: z.enum(["reply", "goal-progress", "completed", "approval", "question", "error", "stopped", "interrupted", "blocked", "max-tokens"]),
  goal: z.object({ id, revision: counter.positive(), round: counter }).strict().optional(),
  stage: z.enum(["initial", "reminder"]),
  title: z.string().max(256),
  body: z.string().max(2048),
  requestIds: z.array(id).max(100).default([]),
  source: z.enum(["event", "runtime"]).optional()
}).strict();
function noticeId(sessionId, turn, seq, category, stage, occurrence = 0, runtimeId) {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error("Invalid notification occurrence");
  if (runtimeId !== void 0 && !runtimeId.length) throw new Error("Invalid runtime request id");
  const tuple = [sessionId, turn, seq, category, stage];
  if (runtimeId !== void 0) tuple.push(runtimeId);
  if (occurrence > 0) tuple.push(occurrence);
  return JSON.stringify(tuple);
}
function interactionId(sessionId, kind, nativeId) {
  return JSON.stringify([sessionId, kind, nativeId]);
}
var interactionSchema = z.object({
  id,
  sessionId: id,
  nativeId: id,
  kind: z.enum(["approval", "question"]),
  turn: counter,
  seq: counter,
  createdAt: counter,
  preview: z.string().max(2048),
  state: z.enum(["open", "continued", "settled"]),
  source: z.enum(["event", "runtime"]).optional(),
  dueAt: counter.nullable(),
  automaticReminders: z.number().int().min(0).max(1)
}).strict();
var runtimeSchema = z.object({
  phase: z.enum(["stopped", "starting", "running", "stopping", "recovering", "error"]),
  generation: counter,
  visibilityRevision: counter,
  visible: z.boolean(),
  suspended: z.boolean(),
  error: z.string().max(600).optional(),
  desiredVisible: z.boolean().optional(),
  recoveryAttempt: counter.max(3).optional(),
  retryAt: counter.optional()
}).strict();
var deliveryClaimSchema = z.object({
  token: id,
  clientId: id,
  generation: counter,
  visibilityRevision: counter,
  expiresAt: counter,
  notice: noticeSchema
}).strict();
var deliveryReceiptSchema = z.object({
  token: id,
  clientId: id,
  noticeId: id,
  generation: counter,
  state: z.enum(["requested", "shown", "clicked", "failed", "unknown"]),
  time: counter,
  detail: z.string().max(600).optional()
}).strict();
var notificationRequests = {
  state: z.object({ locale: z.string().min(2).max(64).regex(/^[a-zA-Z0-9-]+$/).optional() }).strict(),
  claim: z.object({ clientId: id, generation: counter }).strict(),
  receipt: deliveryReceiptSchema,
  test: z.object({ clientId: id, generation: counter }).strict(),
  snooze: z.object({ interactionId: id, generation: counter }).strict()
};
var notificationEndpoints = ["notification-state", "notification-claim", "notification-receipt", "notification-snooze", "notification-test"];

// src/notification-broker.ts
var realClock = {
  now: Date.now,
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer)
};
var title = {
  reply: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210",
  "goal-progress": "\u76EE\u6807\u4ECD\u5728\u8FDB\u884C\u4E2D",
  completed: "\u76EE\u6807\u5DF2\u5B8C\u6210",
  approval: "\u7B49\u4F60\u786E\u8BA4",
  question: "\u6709\u4E2A\u95EE\u9898\u60F3\u95EE\u4F60",
  error: "\u9700\u8981\u5173\u6CE8",
  stopped: "\u5148\u505C\u5728\u8FD9\u91CC",
  interrupted: "\u4EFB\u52A1\u4E2D\u65AD\u4E86",
  blocked: "\u4EFB\u52A1\u6682\u65F6\u505C\u4E0B\u4E86",
  "max-tokens": "\u8F93\u51FA\u8FBE\u5230\u4E0A\u9650"
};
var body = {
  reply: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  "goal-progress": "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u76EE\u6807\u4ECD\u5728\u8FDB\u884C\u4E2D\u3002",
  completed: "\u76EE\u6807\u5DF2\u5B8C\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  approval: "\u4E0B\u4E00\u6B65\u9700\u8981\u4F60\u786E\u8BA4\u3002",
  question: "\u6709\u4E2A\u95EE\u9898\u60F3\u95EE\u4F60\u3002",
  error: "\u4EFB\u52A1\u9047\u5230\u4E86\u95EE\u9898\uFF0C\u966A\u4F60\u56DE\u53BB\u770B\u770B\u3002",
  stopped: "\u5148\u505C\u5728\u8FD9\u91CC\uFF0C\u968F\u65F6\u7EE7\u7EED\u3002",
  interrupted: "\u8FD9\u6BB5\u4EFB\u52A1\u4E2D\u65AD\u4E86\uFF0C\u966A\u4F60\u56DE\u53BB\u770B\u770B\u3002",
  blocked: "\u770B\u770B\u4E0B\u4E00\u6B65\u600E\u4E48\u7EE7\u7EED\u3002",
  "max-tokens": "\u770B\u770B\u4E0B\u4E00\u6B65\u600E\u4E48\u7EE7\u7EED\u3002"
};
var NotificationBroker = class {
  constructor(options = {}) {
    this.options = options;
    this.clock = options.clock ?? realClock;
  }
  clock;
  prefs = notificationPreferencesSchema.parse({});
  run = { phase: "stopped", generation: 0, visibilityRevision: 0, visible: false, suspended: false };
  sources = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  deliveries = /* @__PURE__ */ new Map();
  clients = /* @__PURE__ */ new Map();
  problems = [];
  timer;
  closed = false;
  snapshot() {
    return { protocol: NOTIFICATION_PROTOCOL, runtime: { ...this.run }, interactions: [...this.requests.values()].filter((r) => r.state !== "settled").map((r) => this.publicRequest(r)) };
  }
  /** Bounded diagnostics; a requested receipt alone never means the OS displayed a notification. */
  diagnostics() {
    return this.problems.map((p) => ({ ...p }));
  }
  history() {
    return [...this.deliveries.values()].map((d) => ({ notice: structuredClone(d.notice), state: d.state, receipts: d.receipts.map((r) => ({ ...r })) }));
  }
  preferences(value) {
    const delayChanged = value.reminderDelayMs !== void 0 && value.reminderDelayMs !== this.prefs.reminderDelayMs;
    this.prefs = notificationPreferencesSchema.parse({ ...this.prefs, ...value });
    if (!this.prefs.reminders) {
      for (const delivery of this.deliveries.values()) if (delivery.notice.stage === "reminder") this.cancel(delivery);
    }
    if (!this.prefs.notifications) this.cancelDeliveries();
    for (const request of this.requests.values()) {
      if (request.state === "settled") continue;
      if (!this.prefs.notifications || !this.prefs.reminders) request.dueAt = null;
      else if ((request.dueAt === null || delayChanged) && request.automaticReminders === 0) request.dueAt = this.clock.now() + this.prefs.reminderDelayMs;
    }
    this.refresh();
  }
  runtime(value) {
    const next = runtimeSchema.parse(value);
    if (next.phase === "running" && this.run.phase === "running" && next.generation === this.run.generation && next.visibilityRevision === this.run.visibilityRevision && next.visible !== this.run.visible) return false;
    if (this.closed || next.generation < this.run.generation || next.generation === this.run.generation && next.visibilityRevision < this.run.visibilityRevision) return false;
    const generationChanged = next.generation !== this.run.generation;
    const changed = next.generation !== this.run.generation || next.visibilityRevision !== this.run.visibilityRevision || next.phase !== this.run.phase || next.suspended !== this.run.suspended;
    if (changed) for (const delivery of this.deliveries.values()) {
      if (next.generation === this.run.generation && next.phase === "running" && !next.suspended && !delivery.claim && delivery.state === "pending") {
        delivery.state = "pending";
        delivery.claim = void 0;
      } else this.cancel(delivery);
    }
    this.run = next;
    if (next.phase !== "running" || generationChanged) for (const r of this.requests.values()) r.dueAt = null;
    if (next.phase === "running") {
      for (const r of this.requests.values()) if (r.state !== "settled" && r.automaticReminders === 0 && r.dueAt === null && this.prefs.reminders && this.prefs.notifications) r.dueAt = this.clock.now() + this.prefs.reminderDelayMs;
    }
    this.refresh();
    return true;
  }
  /** Baseline history folds pending state; it never replays proactive initial or reminder notices. */
  restore(session, questions) {
    if (session.header.origin === "subagent" || this.sources.has(session.id)) return;
    this.source(session);
    for (const event of session.snapshotEvents?.() ?? []) this.event(session, event, false);
    if (questions) this.questions(session, questions, false);
    this.refresh();
  }
  consume(session, event) {
    if (this.closed || session.header.origin === "subagent") return;
    this.event(session, event, true);
    this.refresh();
  }
  source(session) {
    let state = this.sources.get(session.id);
    if (!state) {
      if (this.sources.size >= 100) this.remove(this.sources.keys().next().value);
      state = { completion: new CompletionTracker(), ended: -1, seq: -1, turn: 0, finalText: "", calls: /* @__PURE__ */ new Map(), label: session.header.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "\u4F1A\u8BDD" };
      this.sources.set(session.id, state);
    }
    return state;
  }
  event(session, event, live) {
    const source = this.source(session);
    if (event.seq <= source.seq) return;
    source.seq = event.seq;
    const completion = source.completion.consume(event);
    if (event.type === "goal/change" && completion && !completion.silent && live) {
      this.enqueue({ ...this.notice(session.id, source.turn, event.seq, event.time, completion.category, completion.text), goal: completion.goal });
    }
    if (event.type === "approval/decided") {
      this.settle(interactionId(session.id, "approval", event.data.id));
      return;
    }
    if (event.type === "user/message") {
      const reply2 = event.data.source;
      if (reply2.kind === "user-question-reply" && reply2.callId) {
        this.settle(interactionId(session.id, "question", reply2.callId));
        return;
      }
    }
    if ("turn" in event.data && event.data.turn !== void 0 && event.data.turn < source.turn) return;
    switch (event.type) {
      case "turn/start":
        if (event.data.turn <= source.ended) break;
        source.turn = event.data.turn;
        source.finalText = "";
        break;
      case "tool/call":
        if (event.data.name === "ask_user_question") this.origin(source, event.data.callId, event.data.turn, event.seq, event.time);
        break;
      case "tool/ptc-dispatch":
        if (event.data.name === "ask_user_question") this.origin(source, event.data.subCallId, source.turn, event.seq, event.time);
        break;
      case "assistant/message":
        source.finalText = event.data.message.content.some((p) => p.type === "tool-call") ? "" : event.data.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        break;
      case "approval/asked":
        this.open(session.id, "approval", event.data.id, source.turn, event.seq, event.time, `${event.data.toolName}: ${event.data.reason ?? body.approval}`, false, live);
        break;
      case "turn/end": {
        if (event.data.turn <= source.ended) break;
        source.ended = event.data.turn;
        source.turn = event.data.turn;
        if (event.data.reason.kind === "forked") break;
        const category = completion?.category ?? (event.data.reason.kind === "aborted" ? "stopped" : event.data.reason.kind);
        if (live) this.enqueue({ ...this.notice(session.id, source.turn, event.seq, event.time, category, source.finalText && event.data.reason.kind === "completed" ? source.finalText : completion?.text ?? body[category]), ...completion?.goal ? { goal: completion.goal } : {} });
        source.finalText = "";
        for (const r of this.requests.values()) if (r.sessionId === session.id && r.kind === "approval" && r.turn <= source.turn) this.settle(r.id);
        break;
      }
    }
  }
  /** Public projection is authoritative for timed questions, including continued questions after turn/end. */
  questions(session, projection, live = true) {
    if (this.closed || session.header.origin === "subagent") return;
    const source = this.source(session), active = /* @__PURE__ */ new Set();
    for (const question of projection.active) {
      const id2 = interactionId(session.id, "question", question.callId);
      active.add(id2);
      let origin = source.calls.get(question.callId);
      if (!origin) {
        const events = session.snapshotEvents?.() ?? [];
        const event = events.map((event2) => event2).findLast((event2) => event2.type === "tool/call" && event2.data.callId === question.callId && event2.data.name === "ask_user_question" || event2.type === "tool/ptc-dispatch" && event2.data.subCallId === question.callId && event2.data.name === "ask_user_question");
        if (event) {
          const start = events.findLast((prior) => prior.type === "turn/start" && prior.seq < event.seq);
          const turn = "turn" in event.data && event.data.turn !== void 0 ? event.data.turn : start?.type === "turn/start" ? start.data.turn : 0;
          origin = { turn, seq: event.seq, time: event.time };
        }
      }
      const existing = this.requests.get(id2);
      if (!origin && existing) origin = { turn: existing.turn, seq: existing.seq, time: existing.createdAt };
      if (!origin) {
        if (!this.problems.some((p) => p.sessionId === session.id && p.nativeId === question.callId)) this.problems.push({ code: "question-source-unavailable", sessionId: session.id, nativeId: question.callId });
        if (this.problems.length > 100) this.problems.shift();
        continue;
      }
      this.open(session.id, "question", question.callId, origin.turn, origin.seq, origin.time, question.questions.map((q) => q.question).join("\n"), true, live, question.state);
    }
    for (const r of this.requests.values()) if (r.sessionId === session.id && r.projected && !active.has(r.id)) this.settle(r.id);
    for (const q of projection.settled ?? []) this.settle(interactionId(session.id, "question", q.callId));
    this.refresh();
  }
  origin(source, id2, turn, seq, time) {
    source.calls.set(id2, { turn, seq, time });
    if (source.calls.size > 200) source.calls.delete(source.calls.keys().next().value);
  }
  /** Observe a runtime blocking request without claiming the answerer chain. */
  question(session, question) {
    if (this.closed || session.header.origin === "subagent" || question.signal?.aborted) return () => {
    };
    this.source(session);
    const id2 = interactionId(session.id, "question", question.nativeId);
    this.open(session.id, "question", question.nativeId, question.turn, question.seq, this.clock.now(), question.preview, false, true, "open", question.source);
    const request = this.requests.get(id2);
    if (!request) {
      this.problems.push({ code: "request-capacity-exceeded", sessionId: session.id, nativeId: question.nativeId });
      if (this.problems.length > 100) this.problems.shift();
      return () => {
      };
    }
    const finish = () => {
      if (!request.projected) this.settle(id2);
      this.refresh();
    };
    question.signal?.addEventListener("abort", finish, { once: true });
    request.cleanup?.();
    request.cleanup = () => question.signal?.removeEventListener("abort", finish);
    this.refresh();
    return finish;
  }
  open(sessionId, kind, nativeId, turn, seq, time, preview, projected, live, state = "open", sourceKind) {
    const id2 = interactionId(sessionId, kind, nativeId), existing = this.requests.get(id2);
    if (existing) {
      if (existing.state !== "settled") {
        existing.state = state;
        existing.projected ||= projected;
        existing.preview = preview.slice(0, 2048);
      }
      return;
    }
    if (this.requests.size >= 500) {
      const old = [...this.requests.values()].find((r) => r.state === "settled");
      if (old) this.requests.delete(old.id);
      else return;
    }
    const request = { id: id2, nativeId, sessionId, kind, turn, seq, createdAt: time, preview: preview.slice(0, 2048), state, dueAt: live && this.prefs.notifications && this.run.phase === "running" && this.prefs.reminders ? this.clock.now() + this.prefs.reminderDelayMs : null, automaticReminders: live ? 0 : 1, projected, snoozes: 0, ...sourceKind ? { source: sourceKind } : {} };
    this.requests.set(id2, request);
    if (live) {
      const notice = this.notice(sessionId, turn, seq, time, kind, request.preview, [id2]);
      if (sourceKind) notice.source = sourceKind;
      if (sourceKind === "runtime") notice.id = this.identity(notice, 0, nativeId);
      this.enqueue(notice);
    }
  }
  settle(id2) {
    const request = this.requests.get(id2);
    if (!request || request.state === "settled") return;
    request.state = "settled";
    request.dueAt = null;
    request.cleanup?.();
    request.cleanup = void 0;
    for (const delivery of this.deliveries.values()) {
      if (!delivery.notice.requestIds.includes(id2) || delivery.requested || ["role", "cancelled"].includes(delivery.state)) continue;
      if (delivery.claim) {
        this.cancel(delivery);
        continue;
      }
      delivery.notice.requestIds = delivery.notice.requestIds.filter((key) => key !== id2 && this.requests.get(key)?.state !== "settled");
      if (!delivery.notice.requestIds.length) delivery.state = "cancelled";
      else this.cancel(delivery);
    }
  }
  snooze(id2, generation) {
    const request = this.requests.get(id2);
    if (!this.eligible() || generation !== this.run.generation || !this.prefs.reminders || !request || request.state === "settled") return false;
    for (const delivery of this.deliveries.values()) if (!delivery.requested && delivery.notice.requestIds.includes(id2) && ["pending", "claimed"].includes(delivery.state)) this.cancel(delivery);
    request.dueAt = this.clock.now() + this.prefs.reminderDelayMs;
    request.snoozes++;
    this.refresh();
    return true;
  }
  /** A live client poll refreshes its bounded liveness record and can own one eligible notice. */
  claim(clientId, generation, noticeId2) {
    if (!clientId || clientId.length > 2048 || this.closed || generation !== this.run.generation) return null;
    this.clients.set(clientId, this.clock.now());
    if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value);
    this.tick();
    if (!this.eligible() || this.run.visible || !this.prefs.systemNotifications) return null;
    if ([...this.deliveries.values()].some((d) => d.claim?.clientId === clientId && ["claimed", "requested"].includes(d.state))) return null;
    const delivery = [...this.deliveries.values()].find((d) => d.state === "pending" && this.valid(d.notice) && (noticeId2 === void 0 || d.notice.id === noticeId2));
    if (!delivery) return null;
    const claim = { token: this.options.token?.() ?? randomUUID(), clientId, generation, visibilityRevision: this.run.visibilityRevision, expiresAt: this.clock.now() + (this.options.claimDurationMs ?? 15e3), notice: structuredClone(delivery.notice) };
    delivery.state = "claimed";
    delivery.claim = claim;
    this.refresh();
    return structuredClone(claim);
  }
  receipt(value) {
    const parsed = deliveryReceiptSchema.safeParse(value);
    if (!parsed.success || this.closed) return false;
    const receipt = parsed.data, delivery = this.deliveries.get(receipt.noticeId), claim = delivery?.claim;
    if (!delivery || !claim || claim.token !== receipt.token || claim.clientId !== receipt.clientId || claim.generation !== receipt.generation || delivery.state === "cancelled") return false;
    if (receipt.state === "requested") {
      if (!["claimed", "unknown"].includes(delivery.state) || delivery.requested) return false;
      delivery.requested = true;
    } else if (receipt.state === "failed") {
      if (!["claimed", "requested", "shown", "unknown"].includes(delivery.state)) return false;
    } else {
      if (!delivery.requested || delivery.state === "failed" || delivery.state === "clicked") return false;
      if (receipt.state === "unknown" && delivery.state !== "requested") return false;
      if (receipt.state === "shown" && !["requested", "unknown"].includes(delivery.state)) return false;
      if (receipt.state === "clicked" && !["requested", "shown", "unknown"].includes(delivery.state)) return false;
    }
    delivery.state = receipt.state;
    if (delivery.receipts.length < 5) delivery.receipts.push({ ...receipt });
    this.refresh();
    return true;
  }
  eligible() {
    return !this.closed && this.prefs.notifications && this.run.phase === "running" && this.run.visibilityRevision > 0 && !this.run.suspended;
  }
  valid(notice) {
    return !notice.requestIds.length || notice.requestIds.some((id2) => this.requests.get(id2)?.state !== "settled" && this.requests.has(id2));
  }
  notice(sessionId, turn, seq, time, category, preview, requestIds = [], stage = "initial") {
    return noticeSchema.parse({ id: noticeId(sessionId, turn, seq, category, stage), sessionId, turn, seq, time, category, stage, title: `${this.sources.get(sessionId)?.label ?? "\u4F1A\u8BDD"} \xB7 ${title[category]}`.slice(0, 256), body: preview.slice(0, 2048), requestIds });
  }
  identity(notice, occurrence = 0, runtimeId) {
    return noticeId(notice.sessionId, notice.turn, notice.seq, notice.category, notice.stage, occurrence, runtimeId);
  }
  enqueue(notice) {
    if (!this.eligible() || this.deliveries.has(notice.id)) return;
    this.deliveries.set(notice.id, { notice, state: "pending", requested: false, receipts: [] });
    if (this.deliveries.size > 300) {
      const old = [...this.deliveries.entries()].find(([, d]) => d.state !== "claimed" && d.state !== "requested");
      if (old) this.deliveries.delete(old[0]);
    }
  }
  cancel(delivery) {
    if (delivery.claim && !["shown", "clicked", "failed"].includes(delivery.state)) delivery.state = "unknown";
    else if (!delivery.claim && delivery.state !== "role") delivery.state = "cancelled";
  }
  cancelDeliveries() {
    for (const d of this.deliveries.values()) this.cancel(d);
  }
  /** Callbacks always recompute request truth immediately before creating or dispatching a notice. */
  tick() {
    if (this.closed) return;
    const now = this.clock.now();
    for (const [id2, time] of this.clients) if (now - time >= (this.options.clientLifetimeMs ?? 3e4)) this.clients.delete(id2);
    for (const delivery of this.deliveries.values()) {
      if (!delivery.claim || !["claimed", "requested"].includes(delivery.state)) continue;
      if (delivery.claim.expiresAt > now && this.clients.has(delivery.claim.clientId)) continue;
      delivery.state = "unknown";
    }
    if (this.eligible() && this.prefs.reminders) {
      const groups = /* @__PURE__ */ new Map();
      for (const request of this.requests.values()) if (request.state !== "settled" && request.dueAt !== null && request.dueAt <= now) {
        const group = groups.get(request.sessionId) ?? [];
        group.push(request);
        groups.set(request.sessionId, group);
      }
      for (const [sessionId, requests] of groups) for (let start = 0; start < requests.length; start += 100) {
        const group = requests.slice(start, start + 100);
        const origin = group[0], notice = this.notice(sessionId, origin.turn, origin.seq, now, origin.kind, group.length > 1 ? `\u8FD8\u6709 ${group.length} \u4EF6\u4E8B\u7B49\u4F60\u770B\u770B\u3002` : "\u521A\u624D\u90A3\u4EF6\u4E8B\uFF0C\u8FD8\u7B49\u4F60\u770B\u770B\u3002", group.map((r) => r.id), "reminder");
        const occurrence = Math.max(...group.map((r) => r.snoozes));
        if (origin.source === "runtime") {
          notice.source = "runtime";
          notice.id = this.identity(notice, occurrence, origin.nativeId);
        } else if (occurrence) notice.id = this.identity(notice, occurrence);
        for (const request of group) {
          request.dueAt = null;
          request.automaticReminders = 1;
        }
        this.enqueue(notice);
      }
    }
    if (this.eligible() && this.run.visible) for (const delivery of this.deliveries.values()) {
      if (delivery.state !== "pending" || !this.valid(delivery.notice)) continue;
      const state = { ...this.run };
      try {
        if (this.options.presentRole?.(structuredClone(delivery.notice), state)) delivery.state = "role";
      } catch {
        delivery.state = "failed";
      }
    }
  }
  refresh() {
    this.tick();
    if (this.timer !== void 0) this.clock.clearTimeout(this.timer);
    this.timer = void 0;
    if (!this.closed) {
      const due = this.eligible() ? [...this.requests.values()].flatMap((r) => r.dueAt === null ? [] : [r.dueAt]) : [];
      for (const d of this.deliveries.values()) if (d.claim && ["claimed", "requested"].includes(d.state)) due.push(Math.min(d.claim.expiresAt, (this.clients.get(d.claim.clientId) ?? this.clock.now()) + (this.options.clientLifetimeMs ?? 3e4)));
      if (due.length) this.timer = this.clock.setTimeout(() => {
        this.timer = void 0;
        this.refresh();
      }, Math.max(1, Math.min(...due) - this.clock.now()));
      try {
        this.options.changed?.();
      } catch {
      }
    }
  }
  publicRequest(r) {
    const { projected: _projected, snoozes: _snoozes, cleanup: _cleanup, ...value } = r;
    return { ...value };
  }
  remove(sessionId) {
    this.sources.delete(sessionId);
    for (const [id2, r] of this.requests) if (r.sessionId === sessionId) {
      r.cleanup?.();
      this.requests.delete(id2);
    }
    for (const [id2, d] of this.deliveries) if (d.notice.sessionId === sessionId) this.deliveries.delete(id2);
    this.refresh();
  }
  dispose() {
    this.closed = true;
    if (this.timer !== void 0) this.clock.clearTimeout(this.timer);
    this.timer = void 0;
    for (const r of this.requests.values()) r.cleanup?.();
    this.cancelDeliveries();
    this.clients.clear();
    this.sources.clear();
    this.requests.clear();
    this.deliveries.clear();
    this.problems.length = 0;
  }
};

// src/chat.ts
import { SessionId } from "@deepseek-ai/dsh-session";

// web/chat-contract.js
function chatRequest(value) {
  if (!value || value.type !== "chat" || Object.keys(value).some((k) => !["type", "sessionId", "requestId", "text", "clientTimeZone"].includes(k))) return;
  if (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 512 || typeof value.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.requestId)) return;
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 2e3 || typeof value.clientTimeZone !== "string" || value.clientTimeZone.length > 100) return;
  try {
    const clientTimeZone = new Intl.DateTimeFormat("en", { timeZone: value.clientTimeZone }).resolvedOptions().timeZone;
    return { type: "chat", sessionId: value.sessionId, requestId: value.requestId, text: value.text.trim(), clientTimeZone };
  } catch {
    return;
  }
}

// src/chat.ts
var ChatSubmission = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  tails = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  async submit(value, signal) {
    const input = chatRequest(value);
    if (!input) return;
    const identity = JSON.stringify(input);
    const result = (status, code) => status === "accepted" ? { type: "chat-result", sessionId: input.sessionId, requestId: input.requestId, status } : { type: "chat-result", sessionId: input.sessionId, requestId: input.requestId, status, code };
    if (this.requests.has(input.requestId) && this.requests.get(input.requestId) !== identity) return result("failed", "coopanion/request-conflict");
    this.requests.set(input.requestId, identity);
    if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value);
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    const task = previous.catch(() => {
    }).then(async () => {
      try {
        await this.admit(input, signal);
        return result("accepted");
      } catch (error) {
        const code = signal.aborted ? "gateway/cancelled" : chatErrorCode(error);
        return result("failed", code);
      }
    });
    this.tails.set(input.sessionId, task);
    try {
      return await task;
    } finally {
      if (this.tails.get(input.sessionId) === task) this.tails.delete(input.sessionId);
    }
  }
  async admit(input, signal) {
    const reject = (code) => {
      throw Object.assign(new Error(code), { code });
    };
    signal.throwIfAborted();
    const controller = this.ctx.get("sessionController"), query = this.ctx.get("sessionQuery");
    if (!controller || !query) reject("coopanion/service-unavailable");
    const observed = await query.observeSession(SessionId(input.sessionId), { signal });
    try {
      if (observed.header.id !== input.sessionId || !observed.header.cwd) reject("session/not-found");
      if (observed.header.origin === "subagent") reject("session/subagent-owned");
      const messages = observed.events.flatMap((event) => event.type === "user/message" ? [event.data] : event.type === "agent/inbox/spliced" ? event.data.inserted : []);
      const matches = messages.filter((message) => message.source.kind === "user" && "rpcId" in message.source && message.source.rpcId === input.requestId);
      if (matches.length) {
        if (matches.some((message) => JSON.stringify(message.content) !== JSON.stringify([{ type: "text", text: input.text }]) || !("clientTimeZone" in message.source) || message.source.clientTimeZone !== input.clientTimeZone)) reject("coopanion/request-conflict");
        return;
      }
      const catalog = await controller.modelCatalog();
      const selected = observed.projections?.values.modelSelection?.next ?? catalog.default;
      if (!catalog.groups.some((group) => group.id === selected.provider && group.models.some((model) => model.id === selected.model))) reject("session/model-unavailable");
    } finally {
      observed[Symbol.dispose]();
    }
    signal.throwIfAborted();
    const receipt = await controller.prompt({ sessionId: SessionId(input.sessionId), requestId: input.requestId, mode: "queue", content: [{ type: "text", text: input.text }], clientTimeZone: input.clientTimeZone }, signal);
    if (receipt.accepted !== true) reject("coopanion/no-receipt");
  }
};
function chatErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const value = current;
    if (value.code === "EACCES" || value.code === "EPERM") return "gateway/forbidden";
    current = value.cause;
  }
  const code = error?.code;
  if (code === "SESSION_QUERY_SESSION_NOT_FOUND") return "session/not-found";
  if (code === "SESSION_QUERY_ABORTED") return "gateway/cancelled";
  return typeof code === "string" ? code : "coopanion/unavailable";
}

// src/index.ts
import z2 from "@deepseek-ai/schemastery";

// src/bridge.ts
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

// src/desktop-lifecycle.ts
var NativeStartError = class extends Error {
  constructor(message, recoverable) {
    super(message);
    this.recoverable = recoverable;
    this.name = "NativeStartError";
  }
};

// src/electron-runtime.ts
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
async function electronExecutable(signal) {
  const directory = dirname(createRequire(import.meta.url).resolve("electron"));
  async function installed() {
    let relative;
    try {
      relative = await readFile(join(directory, "path.txt"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      relative = "";
    }
    if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return join(process.env.ELECTRON_OVERRIDE_DIST_PATH, relative || "electron");
    if (!relative) return;
    const executable2 = join(directory, "dist", relative);
    try {
      await access(executable2);
      return executable2;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (signal.aborted) throw new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88");
  const existing = await installed();
  if (existing) return existing;
  await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88"));
      return;
    }
    const child = spawn(process.execPath, [join(directory, "install.js")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
      windowsHide: true
    });
    let failure, killTimer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1e3);
    };
    const aborted = () => stop(new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88"));
    const timer = setTimeout(() => stop(new NativeStartError("Electron \u8FD0\u884C\u65F6\u51C6\u5907\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u6309\u4F7F\u7528\u6307\u5357\u9884\u5148\u5B89\u88C5\u8FD0\u884C\u65F6\u3002", false)), 24e4);
    signal.addEventListener("abort", aborted, { once: true });
    const finish = (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", aborted);
      if (failure || error) reject(failure ?? error);
      else resolve();
    };
    child.once("error", (error) => finish(new NativeStartError(error.message.slice(0, 600), false)));
    child.once("exit", (code) => finish(code === 0 ? void 0 : new NativeStartError(`Electron \u8FD0\u884C\u65F6\u51C6\u5907\u5931\u8D25 (${code})\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u6309\u4F7F\u7528\u6307\u5357\u9884\u5148\u5B89\u88C5\u8FD0\u884C\u65F6\u3002`, false)));
    if (signal.aborted) aborted();
  });
  if (signal.aborted) throw new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88");
  const executable = await installed();
  if (!executable) throw new NativeStartError("Electron \u5B89\u88C5\u672A\u751F\u6210\u53EF\u7528\u8FD0\u884C\u65F6\uFF0C\u8BF7\u6309\u4F7F\u7528\u6307\u5357\u91CD\u65B0\u51C6\u5907\u3002", false);
  return executable;
}

// src/bridge.ts
var ElectronBridge = class extends EventEmitter {
  child;
  latest;
  latestOptions;
  resultKey;
  closing = false;
  preparing;
  preparation;
  generation = 0;
  visibilityRevision = 0;
  nativeVisible = false;
  suspended = false;
  screenLocked = false;
  systemAsleep = false;
  lastNotificationState;
  async start(options, lifetime) {
    if (this.child || this.preparing) throw new NativeStartError("Desktop pet is already running or starting", false);
    if (lifetime?.signal.aborted) throw new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88");
    this.latestOptions = { ...options };
    this.closing = false;
    this.generation = lifetime?.generation ?? this.generation + 1;
    this.visibilityRevision = 0;
    this.nativeVisible = false;
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new NativeStartError("\u684C\u5BA0\u9700\u8981\u684C\u9762\u663E\u793A\u73AF\u5883\u3002", false);
    let executable;
    if (options.electronPath !== void 0) executable = options.electronPath;
    else {
      const preparing = new AbortController();
      this.preparing = preparing;
      const abort = () => preparing.abort();
      lifetime?.signal.addEventListener("abort", abort, { once: true });
      if (lifetime?.signal.aborted) abort();
      try {
        this.preparation = electronExecutable(preparing.signal);
        executable = await this.preparation;
        if (preparing.signal.aborted || this.closing) throw new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88");
      } catch (error) {
        throw error instanceof NativeStartError ? error : new NativeStartError(String(error).slice(0, 600), false);
      } finally {
        lifetime?.signal.removeEventListener("abort", abort);
        this.preparing = void 0;
        this.preparation = void 0;
      }
    }
    const env = { ...process.env, DSH_PET_GENERATION: String(this.generation), DSH_PET_VISIBLE: lifetime?.visible === false ? "0" : "1", DSH_PET_SCREEN_LOCKED: this.screenLocked ? "1" : "0", DSH_PET_SYSTEM_ASLEEP: this.systemAsleep ? "1" : "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [fileURLToPath(new URL("../desktop/main.cjs", import.meta.url))];
    if (env.DSH_PET_TEST_NO_SANDBOX === "1") args.unshift("--no-sandbox");
    const child = spawn2(executable, args, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const generation = this.generation;
    this.child = child;
    let diagnostic = "", userClosed = false;
    child.stderr?.on("data", (data) => {
      diagnostic = (diagnostic + data.toString()).slice(-4e3);
    });
    child.on("message", (message) => {
      if (this.child !== child || this.closing || lifetime?.signal.aborted || !isRecord(message)) return;
      if (message.type === "closed") userClosed = true;
      if (message.type === "action") this.emit("action", message.action);
      if (message.type === "tray-state") this.emit("tray-state", message.state);
      if (message.type === "tray-icon") this.emit("tray-icon", message);
      if (message.type === "visibility" && message.generation === generation && typeof message.visible === "boolean" && Number.isSafeInteger(message.visibilityRevision) && message.visibilityRevision > this.visibilityRevision) {
        this.visibilityRevision = message.visibilityRevision;
        this.nativeVisible = message.visible;
        this.suspended = message.suspended === true;
        if (typeof message.screenLocked === "boolean") this.screenLocked = message.screenLocked;
        if (typeof message.systemAsleep === "boolean") this.systemAsleep = message.systemAsleep;
        this.emit("lifecycle", { running: true, visible: this.nativeVisible, generation, visibilityRevision: this.visibilityRevision, suspended: this.suspended, ...typeof message.desiredVisible === "boolean" ? { desiredVisible: message.desiredVisible } : {} });
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = void 0;
      this.nativeVisible = false;
      const unexpected = !this.closing && !userClosed && !lifetime?.signal.aborted;
      const error = unexpected ? `\u684C\u5BA0\u8FDB\u7A0B\u5DF2\u9000\u51FA (${signal ?? code}): ${diagnostic}`.slice(0, 600) : void 0;
      this.emit("lifecycle", { running: false, visible: false, generation, visibilityRevision: ++this.visibilityRevision, suspended: false, unexpected, ...error ? { error } : {} });
      if (error) this.emit("failure", new Error(error));
    });
    child.on("error", (error) => {
      if (this.child === child && !this.closing && !lifetime?.signal.aborted) this.emit("failure", error);
    });
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off("message", ready2);
        child.off("error", failed);
        child.off("exit", exited);
        lifetime?.signal.removeEventListener("abort", aborted);
        if (error) {
          child.kill();
          reject(error);
        } else resolve();
      };
      const ready2 = (message) => {
        if (isRecord(message) && message.type === "startup-error" && this.child === child && typeof message.error === "string") {
          finish(new NativeStartError(message.error.slice(0, 600), message.recoverable === true));
          return;
        }
        if (isRecord(message) && message.type === "ready" && this.child === child && !lifetime?.signal.aborted) {
          this.resultKey = void 0;
          this.send({ type: "init", options: { ...this.latestOptions, locale: this.latestOptions?.locale ?? null }, baseline: true, snapshot: this.latest && desktopSnapshot(this.latest, true) });
          if (this.lastNotificationState) this.notificationState(this.lastNotificationState);
          finish();
        }
      };
      const failed = (error) => finish(new NativeStartError(error.message.slice(0, 600), error.code === "EAGAIN" || error.code === "ENOMEM"));
      const exited = (code, signal) => finish(new NativeStartError(`\u684C\u5BA0\u542F\u52A8\u5931\u8D25 (${signal ?? code}): ${diagnostic}`.slice(0, 600), true));
      const aborted = () => finish(new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88"));
      const timer = setTimeout(() => finish(new NativeStartError(`\u684C\u5BA0\u672A\u80FD\u5728 20 \u79D2\u5185\u542F\u52A8: ${diagnostic}`.slice(0, 600), true)), 2e4);
      child.on("message", ready2);
      child.once("error", failed);
      child.once("exit", exited);
      lifetime?.signal.addEventListener("abort", aborted, { once: true });
      if (lifetime?.signal.aborted) aborted();
    });
  }
  update(snapshot) {
    this.latest = snapshot;
    const key = snapshot.results.map((result) => `${result.id}:${result.read}`).join("|");
    this.send({ type: "snapshot", snapshot: desktopSnapshot(snapshot, key !== this.resultKey) });
    this.resultKey = key;
  }
  notify(notice, runtime) {
    if (!this.child?.connected || this.closing) return false;
    if (runtime && (!this.nativeVisible || this.suspended || runtime.generation !== this.generation || runtime.visibilityRevision !== this.visibilityRevision || !runtime.visible)) return false;
    return this.send({ type: "notice", notice, ...runtime ? { generation: runtime.generation, visibilityRevision: runtime.visibilityRevision } : {} });
  }
  notificationState(snapshot) {
    this.lastNotificationState = structuredClone(snapshot);
    this.send({ type: "notification-state", snapshot });
  }
  snoozeResult(interactionId2, ok, error) {
    this.send({ type: "notification-snooze-result", interactionId: interactionId2, ok, ...error ? { error: error.slice(0, 600) } : {} });
  }
  presentRole(notice, runtime) {
    return this.notify(notice, runtime);
  }
  chatResult(receipt) {
    this.send(receipt);
  }
  onAction(listener) {
    this.on("action", listener);
  }
  removeAction(listener) {
    this.off("action", listener);
  }
  // JSON IPC omits undefined. An explicit null lets a cleared Harness
  // preference restore the renderer's automatic language instead of retaining
  // its previous locale during a merged configuration update.
  configure(options) {
    this.latestOptions = { ...options };
    this.send({ type: "configure", options: { ...options, locale: options.locale ?? null } });
  }
  control(command) {
    this.send({ type: "control", command });
  }
  focusHarness() {
    this.send({ type: "control", command: "focus-harness" });
  }
  onLifecycle(listener) {
    this.on("lifecycle", listener);
  }
  removeLifecycle(listener) {
    this.off("lifecycle", listener);
  }
  send(message) {
    const child = this.child;
    if (!child?.connected || this.closing) return false;
    try {
      child.send(message, (error) => {
        if (error && this.child === child && !this.closing) this.emit("failure", error);
      });
      return true;
    } catch {
      return false;
    }
  }
  async dispose() {
    this.closing = true;
    this.preparing?.abort();
    await this.preparation?.catch(() => void 0);
    const child = this.child;
    if (!child) return;
    if (child.pid === void 0 || child.exitCode !== null || child.signalCode !== null) {
      if (this.child === child) this.child = void 0;
      return;
    }
    await new Promise((resolve, reject) => {
      let deadline;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        deadline = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(new Error("\u684C\u5BA0\u8FDB\u7A0B\u672A\u786E\u8BA4\u9000\u51FA"));
        }, 1e3);
      }, 3e3);
      child.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve();
      });
      if (child.connected) child.send({ type: "quit" }, (error) => {
        if (error) child.kill();
      });
      else child.kill();
    });
    if (this.child === child) this.child = void 0;
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function desktopSnapshot(snapshot, includeResults) {
  const { results, ...state } = snapshot;
  return {
    ...state,
    text: state.mood === "happy" ? "" : state.text,
    sessions: state.sessions.map((session) => ({ ...session, text: session.mood === "happy" ? "" : session.text, reply: "" })),
    ...includeResults ? { results } : {}
  };
}

// src/model.ts
import { basename } from "node:path";
var ready = "\u51C6\u5907\u597D\u4E86\uFF0C\u968F\u65F6\u53EB\u6211\u3002";
var PetModel = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  sessions = /* @__PURE__ */ new Map();
  selected = null;
  tasks = /* @__PURE__ */ new Map();
  results = /* @__PURE__ */ new Map();
  observe(session) {
    if (session.header.origin === "subagent") return;
    let item = this.sessions.get(session.id);
    if (!item) {
      if (this.sessions.size >= 100) {
        const old = [...this.sessions.keys()].find((id2) => id2 !== this.selected);
        if (old) this.remove(old);
      }
      const project = session.header.cwd ? basename(session.header.cwd) : "\u672A\u6307\u5B9A\u9879\u76EE";
      item = { id: session.id, label: project, project, cwd: session.header.cwd ?? "", prompt: "", createdAt: session.header.createdAt, updatedAt: session.header.createdAt, mood: "idle", text: ready, reply: "", replyId: "", unread: 0, revision: 0, active: false, streaming: false, speechId: "" };
      this.sessions.set(session.id, item);
      this.tasks.set(session.id, { completion: new CompletionTracker(), ended: -1, seq: -1, turn: 0, active: false, tools: /* @__PURE__ */ new Map(), approvals: /* @__PURE__ */ new Set(), questions: /* @__PURE__ */ new Set(), requests: /* @__PURE__ */ new Set(), celebrateUntil: 0 });
      this.selected ??= session.id;
      for (const event of session.snapshotEvents?.() ?? []) this.describe(item, event);
    }
    return item;
  }
  /** Fold history as a read baseline; callers reconcile activity with the live Agent status. */
  restore(session) {
    if (!this.observe(session)) return;
    for (const event of session.snapshotEvents?.() ?? []) this.fold(session, event, false);
  }
  describe(item, event) {
    if (event.type !== "user/message" || event.data.source.kind !== "user") return;
    const text = event.data.content.filter((p) => p.type === "text").map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    if (!item.prompt) item.label = Array.from(text).slice(0, 64).join("");
    item.prompt = Array.from(text).slice(0, 160).join("");
    item.updatedAt = event.time;
  }
  /** Live chunks are not session events. Keep attempt identity and ordering separate from durable seq. */
  stream(session, frame) {
    const item = this.observe(session);
    if (!item) return false;
    const task = this.tasks.get(item.id);
    if (frame.type === "start") {
      if (frame.turn < task.turn || frame.turn === task.turn && !task.active && task.seq >= 0 || task.stream && frame.revision <= task.stream.revision) return false;
      task.turn = frame.turn;
      task.active = true;
      task.finalText = void 0;
      task.stream = { id: frame.attemptId, revision: frame.revision, index: -1, text: "", blocks: /* @__PURE__ */ new Map() };
      item.streaming = true;
      item.speechId = frame.attemptId;
      if (!task.tools.size && !task.approvals.size) this.present(item, "thinking", "\u6B63\u5728\u601D\u8003\u2026");
      return true;
    }
    const stream = task.stream;
    if (!task.active || !stream || stream.id !== frame.attemptId || stream.revision !== frame.revision || frame.index <= stream.index) return false;
    stream.index = frame.index;
    if (frame.type === "end") {
      item.streaming = false;
      if (frame.outcome.kind === "abandoned" && !task.tools.size && !task.approvals.size) this.present(item, "thinking", "\u6B63\u5728\u91CD\u65B0\u51C6\u5907\u56DE\u590D\u2026");
      return true;
    }
    const chunk = frame.chunk;
    if (chunk.type === "text-delta" || chunk.type === "block-end" && chunk.block.type === "text") {
      if (chunk.type === "text-delta") stream.blocks.set(chunk.index, ((stream.blocks.get(chunk.index) ?? "") + chunk.text).slice(0, 1200));
      else if (chunk.block.type === "text") stream.blocks.set(chunk.index, chunk.block.text.slice(0, 1200));
      stream.text = [...stream.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n").slice(0, 1200);
      if (stream.text.trim()) {
        if (!task.tools.size && !task.approvals.size) this.present(item, "talking", "\u6B63\u5728\u7EC4\u7EC7\u56DE\u590D\u2026");
      }
    } else if (chunk.type === "reasoning-delta" && !stream.text && !task.tools.size && !task.approvals.size) {
      this.present(item, "thinking", "\u6B63\u5728\u601D\u8003\u2026");
    }
    return true;
  }
  detached(id2) {
    const task = this.tasks.get(id2);
    if (task) task.stream = void 0;
  }
  idle(id2) {
    const item = this.sessions.get(id2), task = this.tasks.get(id2);
    if (!item || !task?.active) return;
    task.active = false;
    task.stream = void 0;
    task.tools.clear();
    task.approvals.clear();
    item.streaming = false;
    this.present(item, "idle", ready);
  }
  /** Keep the user's focus stable when other conversations are created. */
  created(session) {
    const item = this.observe(session);
    if (!item) return false;
    return true;
  }
  /** Baseline already-running agents without replaying old completion notifications. */
  running(session) {
    const item = this.observe(session);
    if (!item || this.tasks.get(item.id).active) return;
    const task = this.tasks.get(item.id);
    task.active = true;
    if (task.requests.size || task.approvals.size) this.present(item, "waiting", item.text);
    else this.present(item, "thinking", "\u6B63\u5728\u5904\u7406\u5F53\u524D\u4F1A\u8BDD\u2026");
  }
  present(item, mood, text) {
    item.active = this.tasks.get(item.id).active;
    if (item.mood === mood && item.text === text) return;
    item.mood = mood;
    item.text = text;
    item.revision++;
  }
  /** Celebration has a deadline independent of UI refreshes or other sessions. */
  settle() {
    let changed = false;
    for (const [id2, task] of this.tasks) {
      if (!task.celebrateUntil || this.now() < task.celebrateUntil) continue;
      task.celebrateUntil = 0;
      const item = this.sessions.get(id2);
      if (!task.active && item.mood === "happy") {
        delete item.completion;
        this.present(item, "idle", ready);
        changed = true;
      }
    }
    return changed;
  }
  consume(session, event) {
    return this.fold(session, event, true);
  }
  fold(session, event, live) {
    const item = this.observe(session);
    if (!item) return;
    const task = this.tasks.get(item.id);
    if (event.seq <= task.seq) return;
    task.seq = event.seq;
    this.describe(item, event);
    const completion = task.completion.consume(event);
    if (event.type === "goal/change" && completion && live) {
      if (!completion.silent || !task.active) this.present(item, completion.mood, completion.text);
      if (completion.clear) delete item.completion;
      else item.completion = completion.category;
      task.celebrateUntil = completion.mood === "happy" ? this.now() + 2500 : 0;
      return completion.silent ? void 0 : { title: `${item.label} \xB7 ${completion.text}`, body: completion.text, sessionId: item.id, kind: "task", category: completion.category, goal: completion.goal };
    }
    if ("turn" in event.data && event.data.turn < task.turn) return;
    switch (event.type) {
      case "turn/start":
        if (event.data.turn <= task.ended) return;
        delete item.completion;
        task.turn = event.data.turn;
        task.active = true;
        task.tools.clear();
        task.approvals.clear();
        task.celebrateUntil = 0;
        task.stream = void 0;
        task.finalText = void 0;
        item.streaming = false;
        item.speechId = "";
        item.updatedAt = event.time;
        this.present(item, "thinking", "\u8BA9\u6211\u60F3\u4E00\u60F3\u2026");
        break;
      case "step/start":
        task.active = true;
        task.finalText = void 0;
        if (!task.approvals.size && !task.tools.size) this.present(item, "thinking", "\u6B63\u5728\u601D\u8003\u2026");
        break;
      case "tool/call":
        if (!task.active) break;
        task.tools.set(event.data.callId, event.data.name);
        if (!task.approvals.size) this.present(item, "working", toolLabel(event.data.name));
        break;
      case "tool/result":
        if (!task.active) break;
        task.tools.delete(event.data.message.toolCallId);
        if (task.approvals.size) break;
        if (task.tools.size) {
          this.present(item, "working", toolLabel(task.tools.values().next().value));
          break;
        }
        if (event.data.message.isError) {
          this.present(item, "thinking", "\u8FD9\u4E00\u6B65\u9047\u5230\u4E86\u95EE\u9898\uFF0C\u6B63\u5728\u5904\u7406\u3002");
        } else {
          this.present(item, "thinking", "\u8FD9\u4E00\u6B65\u5B8C\u6210\u4E86\uFF0C\u7EE7\u7EED\u60F3\u60F3\u2026");
        }
        break;
      case "assistant/message": {
        const text = event.data.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        if (!task.active) break;
        item.streaming = false;
        task.finalText = event.data.message.content.some((p) => p.type === "tool-call") ? void 0 : text;
        if (text.trim() && !task.tools.size && !task.approvals.size) this.present(item, "talking", "\u6B63\u5728\u7EC4\u7EC7\u56DE\u590D\u2026");
        break;
      }
      case "approval/asked": {
        const notice = this.approval(item.id, event.data.toolName, event.data.id);
        return live ? notice : void 0;
      }
      case "approval/decided":
        this.approvalSettled(item.id, event.data.id);
        break;
      case "turn/end": {
        if (event.data.turn <= task.ended) return;
        task.ended = event.data.turn;
        task.turn = event.data.turn;
        task.active = false;
        task.tools.clear();
        task.approvals.clear();
        task.celebrateUntil = 0;
        task.stream = void 0;
        item.streaming = false;
        switch (event.data.reason.kind) {
          case "completed": {
            const text = task.finalText?.trim() ? task.finalText : "";
            if (text) {
              const id2 = `${item.id}:${event.data.turn}:${event.seq}`;
              this.results.set(id2, { id: id2, sessionId: item.id, text, time: event.time, read: !live });
              item.reply = text;
              item.replyId = id2;
              if (live) item.unread++;
              if (this.results.size > 200) {
                const old = [...this.results.values()].find((r) => r.read) ?? this.results.values().next().value;
                this.results.delete(old.id);
                const owner = this.sessions.get(old.sessionId);
                if (owner && !old.read) owner.unread--;
              }
            }
            task.finalText = void 0;
            const outcome = completion;
            item.completion = outcome.category;
            this.present(item, live ? outcome.mood : "idle", live ? outcome.text : ready);
            task.celebrateUntil = live && outcome.mood === "happy" ? this.now() + 2500 : 0;
            return live ? { title: `${item.label} \xB7 ${outcome.text}`, body: text.slice(0, 180) || outcome.text, sessionId: item.id, kind: "task", category: outcome.category, goal: outcome.goal } : void 0;
          }
          case "error":
            this.present(item, "error", "\u4EFB\u52A1\u9047\u5230\u4E86\u95EE\u9898\uFF0C\u8BF7\u56DE\u5230 Harness \u67E5\u770B\u8BE6\u60C5\u3002");
            return live ? { title: `${item.label} \xB7 \u9700\u8981\u5173\u6CE8`, body: item.text, sessionId: item.id, kind: "task" } : void 0;
          case "blocked":
          case "max-tokens":
            this.present(item, "waiting", "\u4EFB\u52A1\u6682\u65F6\u505C\u4E0B\u4E86\uFF0C\u8BF7\u56DE\u5230 Harness \u770B\u770B\u3002");
            return live ? { title: `${item.label} \xB7 \u4EFB\u52A1\u6682\u505C`, body: item.text, sessionId: item.id, kind: "task" } : void 0;
          case "aborted":
            this.present(item, "idle", "\u5148\u505C\u5728\u8FD9\u91CC\uFF0C\u968F\u65F6\u7EE7\u7EED\u3002");
            return live ? { title: `${item.label} \xB7 \u4EFB\u52A1\u5DF2\u505C\u6B62`, body: item.text, sessionId: item.id, kind: "task", category: "stopped" } : void 0;
          case "interrupted":
            this.present(item, "waiting", "\u8FD9\u6BB5\u4EFB\u52A1\u4E2D\u65AD\u4E86\uFF0C\u966A\u4F60\u56DE\u53BB\u770B\u770B\u3002");
            return live ? { title: `${item.label} \xB7 \u4EFB\u52A1\u4E2D\u65AD`, body: item.text, sessionId: item.id, kind: "task", category: "interrupted" } : void 0;
          default:
            this.present(item, "idle", "\u51C6\u5907\u597D\u4E86\uFF0C\u968F\u65F6\u53EB\u6211\u3002");
        }
      }
    }
  }
  approval(id2, tool, token = Symbol()) {
    const item = this.sessions.get(id2);
    if (!item) return;
    const task = this.tasks.get(id2);
    task.active = true;
    task.approvals.add(token);
    task.celebrateUntil = 0;
    this.present(item, "waiting", `${toolLabel(tool)}\u524D\u9700\u8981\u4F60\u786E\u8BA4\uFF0C\u8BF7\u56DE\u5230 Harness\u3002`);
    return { title: `${item.label} \xB7 \u7B49\u4F60\u786E\u8BA4`, body: item.text, sessionId: id2, kind: "task" };
  }
  approvalSettled(id2, token) {
    const item = this.sessions.get(id2);
    const task = this.tasks.get(id2);
    if (!item || !task?.active) return;
    if (token ? !task.approvals.delete(token) : !task.approvals.size) return;
    if (!token) task.approvals.clear();
    if (!task.approvals.size && item.mood === "waiting") {
      this.present(item, task.tools.size ? "working" : "thinking", task.tools.size ? toolLabel(task.tools.values().next().value) : "\u786E\u8BA4\u5DF2\u5904\u7406\uFF0C\u7B49\u5F85\u4EFB\u52A1\u7EE7\u7EED\u2026");
    }
  }
  /** Public request state can outlive a turn; viewing or reading never removes its waiting entrance. */
  interactions(values) {
    for (const [id2, task] of this.tasks) {
      const wasPending = task.requests.size > 0;
      const pending = values.filter((value) => value.sessionId === id2 && value.state !== "settled");
      task.requests = new Set(pending.map((value) => value.id));
      task.questions = new Set(pending.filter((value) => value.kind === "question").map((value) => value.id));
      const item = this.sessions.get(id2);
      if (pending.length) {
        delete item.completion;
        task.celebrateUntil = 0;
        this.present(item, "waiting", pending.some((value) => value.kind === "question") ? "\u6709\u4E2A\u95EE\u9898\u60F3\u95EE\u4F60\uFF0C\u8BF7\u56DE\u5230 Harness \u770B\u770B\u3002" : "\u4E0B\u4E00\u6B65\u9700\u8981\u4F60\u786E\u8BA4\uFF0C\u8BF7\u56DE\u5230 Harness\u3002");
      } else if (wasPending && !task.approvals.size && item.mood === "waiting") {
        this.present(item, task.active ? task.tools.size ? "working" : "thinking" : "idle", task.active ? task.tools.size ? toolLabel(task.tools.values().next().value) : "\u7B49\u5F85\u4EFB\u52A1\u7EE7\u7EED\u2026" : ready);
      }
    }
  }
  select(id2) {
    if (!this.sessions.has(id2)) return false;
    this.selected = id2;
    return true;
  }
  /** Acknowledging an older result cannot clear a newer completion. */
  read(id2) {
    const result = this.results.get(id2);
    if (!result || result.read) return false;
    result.read = true;
    const item = this.sessions.get(result.sessionId);
    if (item) item.unread = Math.max(0, item.unread - 1);
    return true;
  }
  remove(id2) {
    this.sessions.delete(id2);
    this.tasks.delete(id2);
    for (const [key, result] of this.results) if (result.sessionId === id2) this.results.delete(key);
    if (this.selected === id2) this.selected = this.sessions.keys().next().value ?? null;
  }
  snapshot() {
    const item = this.selected ? this.sessions.get(this.selected) : void 0;
    this.settle();
    return { mood: item?.mood ?? "idle", text: item?.text ?? ready, sessionId: item?.id ?? null, revision: item?.revision ?? 0, active: item?.active ?? false, streaming: item?.streaming ?? false, speechId: item?.speechId ?? "", results: [...this.results.values()].map((r) => ({ ...r })), sessions: [...this.sessions.values()].map((s) => ({ ...s })) };
  }
};
function toolLabel(name2) {
  if (/read|cat|view/.test(name2)) return "\u6B63\u5728\u770B\u6587\u4EF6";
  if (/search|grep|find/.test(name2)) return "\u6B63\u5728\u67E5\u627E";
  if (/write|edit|patch/.test(name2)) return "\u6B63\u5728\u5199\u4EE3\u7801";
  if (/bash|shell|exec|terminal/.test(name2)) return "\u6B63\u5728\u8FD0\u884C\u547D\u4EE4";
  if (/web|browse|fetch/.test(name2)) return "\u6B63\u5728\u6D4F\u89C8";
  return `\u6B63\u5728\u4F7F\u7528 ${name2.slice(0, 60)}`;
}

// src/controls.ts
var PetControls = class {
  constructor(bridge, options, limits = {}) {
    this.bridge = bridge;
    this.options = options;
    this.limits = limits;
    bridge.onLifecycle?.(this.changed);
  }
  state = { phase: "stopped", visible: false, desiredVisible: true, recoveryAttempt: 0, generation: 0, visibilityRevision: 0, suspended: false };
  queue = Promise.resolve();
  disposed = false;
  startup;
  startupExit;
  retry;
  stable;
  epoch = 0;
  wanted = false;
  cleanupBlocked = false;
  listeners = /* @__PURE__ */ new Set();
  changed = (event) => {
    if (this.disposed || event.generation !== this.state.generation || !Number.isSafeInteger(event.visibilityRevision) || event.visibilityRevision < this.state.visibilityRevision) return;
    if (event.visibilityRevision === this.state.visibilityRevision && event.visible !== this.state.visible) return;
    if (this.state.phase !== "starting" && this.state.phase !== "running") return;
    const starting = this.state.phase === "starting", wasSuspended = this.state.suspended;
    this.set({ ...this.state, phase: event.running ? starting ? "starting" : "running" : starting ? "starting" : "stopped", visible: event.running && event.visible, visibilityRevision: event.visibilityRevision, suspended: event.suspended ?? false, desiredVisible: starting ? this.state.desiredVisible : event.desiredVisible ?? this.state.desiredVisible, ...event.error ? { error: event.error.slice(0, 600) } : {} });
    if (!event.running) {
      this.clearStable();
      if (starting) {
        this.startupExit = new NativeStartError(event.error ?? "\u684C\u5BA0\u542F\u52A8\u671F\u95F4\u9000\u51FA", event.unexpected === true);
        this.startup?.abort();
      }
      if (!starting) {
        if (!event.unexpected) this.wanted = false;
        else {
          const epoch = this.epoch;
          void this.enqueue(() => this.failed(event.error ?? "\u684C\u5BA0\u8FDB\u7A0B\u610F\u5916\u9000\u51FA", true, epoch));
        }
      }
    } else if (!starting && wasSuspended !== this.state.suspended) this.armStable();
  };
  status() {
    return { ...this.state };
  }
  /** Root assembly registers this listener as a context-owned effect. */
  onState(listener) {
    this.listeners.add(listener);
    try {
      listener(this.status());
    } catch {
    }
    return () => this.listeners.delete(listener);
  }
  configure() {
    this.bridge.configure?.(this.options());
  }
  /**
   * Relay a host-authored hint to the pet as a toast. Delivery is best-effort:
   * it needs a running, visible, awake pet with notices enabled. The result is
   * whether the Host handed the message to the native IPC channel after its own
   * generation/visibility check; the native window re-checks and may still drop
   * it, so true never means the user saw it. Task notices, session replies and
   * delivery claims stay owned by the broker; a hint can never fabricate them.
   * Session ids are navigation identity: they are validated but never rewritten.
   */
  hint(value) {
    if (this.disposed || !this.options().notifications) return false;
    if (this.state.phase !== "running" || !this.state.visible || this.state.suspended) return false;
    const title2 = hintText(value.title, 256), body2 = hintText(value.body, 2048);
    if (!title2) return false;
    const sessionId = hintSessionId(value.sessionId);
    if (sessionId === false) return false;
    return this.bridge.notify({ title: title2, body: body2, sessionId: sessionId ?? "", kind: "message" }, this.status());
  }
  command(command) {
    if (command === "hide") this.set({ ...this.state, desiredVisible: false });
    else if (command === "start" || command === "show" || command === "characters") this.set({ ...this.state, desiredVisible: true });
    if (command === "stop" || command === "restart" || command !== "hide" && this.state.phase !== "starting" && this.state.phase !== "running") {
      this.wanted = command !== "stop";
      this.epoch++;
      this.clearRetry();
      if (command === "stop" || command === "restart") {
        this.startup?.abort();
        this.clearStable();
      }
    }
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (this.disposed) throw new Error("\u684C\u5BA0\u63D2\u4EF6\u5DF2\u505C\u7528");
      if (epoch !== this.epoch) return this.status();
      try {
        let launched = false;
        if (command === "stop" || command === "restart") {
          this.set({ ...this.state, phase: "stopping", visible: false, suspended: false, retryAt: void 0, error: void 0 });
          await this.cleanup();
          this.set({ ...this.state, phase: "stopped", visible: false, suspended: false });
        }
        if (command !== "stop" && command !== "hide" && this.state.phase !== "running") {
          if (this.cleanupBlocked) await this.cleanup();
          this.set({ ...this.state, recoveryAttempt: 0, retryAt: void 0 });
          await this.launch(epoch);
          launched = true;
        }
        if (this.state.phase === "running" && epoch === this.epoch && (!launched || command === "characters")) this.bridge.control?.(command === "characters" ? "characters" : this.state.desiredVisible ? "show" : "hide");
        return this.status();
      } catch (error) {
        await this.failed(error, error instanceof NativeStartError && error.recoverable, epoch);
        return this.status();
      }
    });
  }
  async dispose() {
    this.disposed = true;
    this.wanted = false;
    this.epoch++;
    this.clearRetry();
    this.clearStable();
    this.startup?.abort();
    this.set({ ...this.state, phase: "stopping", visible: false, suspended: false, retryAt: void 0, error: void 0 });
    await this.enqueue(async () => {
      this.bridge.removeLifecycle?.(this.changed);
      const failure = await this.cleanup().then(() => void 0, (error) => this.message(error));
      this.set({ ...this.state, phase: failure ? "error" : "stopped", visible: false, ...failure ? { error: failure } : {} });
      this.listeners.clear();
    });
  }
  async launch(epoch) {
    if (this.disposed || !this.wanted || epoch !== this.epoch) return;
    const startup = new AbortController();
    this.startup = startup;
    this.startupExit = void 0;
    this.set({ ...this.state, phase: "starting", error: void 0, retryAt: void 0, visible: false, generation: this.state.generation + 1, visibilityRevision: 0, suspended: false });
    try {
      await this.withDeadline(this.bridge.start(this.options(), { signal: startup.signal, generation: this.state.generation, visible: this.state.desiredVisible }), this.limits.startTimeoutMs ?? 265e3, "\u684C\u5BA0\u542F\u52A8\u8D85\u65F6", startup.signal, true);
    } catch (error) {
      throw this.startupExit ?? error;
    }
    if (startup.signal.aborted || this.disposed || epoch !== this.epoch) throw new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88");
    this.startup = void 0;
    this.set({ ...this.state, phase: "running" });
    this.armStable();
    this.bridge.control?.(this.state.desiredVisible ? "show" : "hide");
  }
  async failed(error, recoverable, epoch) {
    this.startup?.abort();
    this.startup = void 0;
    this.clearStable();
    const cleanup = await this.cleanup().then(() => "", (failure) => `\uFF1B\u6E05\u7406\u5931\u8D25\uFF1A${this.message(failure).slice(0, 580)}`);
    if (this.disposed || epoch !== this.epoch) return;
    const diagnostic = this.message(error).slice(0, 600 - cleanup.length) + cleanup;
    const attempt = this.state.recoveryAttempt ?? 0;
    if (!this.wanted || !recoverable || cleanup || attempt >= 3) {
      this.set({ ...this.state, phase: "error", visible: false, suspended: false, retryAt: void 0, error: diagnostic });
      return;
    }
    const delay = (this.limits.retryDelaysMs ?? [1e3, 3e3, 1e4])[attempt];
    this.set({ ...this.state, phase: "recovering", visible: false, suspended: false, recoveryAttempt: attempt + 1, retryAt: Date.now() + delay, error: diagnostic });
    this.retry = setTimeout(() => {
      this.retry = void 0;
      void this.enqueue(async () => {
        if (this.disposed || !this.wanted || epoch !== this.epoch) return;
        try {
          await this.launch(epoch);
        } catch (failure) {
          await this.failed(failure, failure instanceof NativeStartError && failure.recoverable, epoch);
        }
      });
    }, delay);
    this.retry.unref?.();
  }
  clearRetry() {
    clearTimeout(this.retry);
    this.retry = void 0;
  }
  clearStable() {
    clearTimeout(this.stable);
    this.stable = void 0;
  }
  armStable() {
    this.clearStable();
    if (this.state.suspended) return;
    const generation = this.state.generation;
    this.stable = setTimeout(() => {
      this.stable = void 0;
      if (!this.disposed && this.state.phase === "running" && generation === this.state.generation) this.set({ ...this.state, recoveryAttempt: 0 });
    }, this.limits.stableMs ?? 6e4);
    this.stable.unref?.();
  }
  message(error) {
    return String(error instanceof Error ? error.message : error).slice(0, 600);
  }
  async cleanup() {
    this.cleanupBlocked = true;
    await this.withDeadline(Promise.resolve().then(() => this.bridge.dispose()), this.limits.cleanupTimeoutMs ?? 5e3, "\u684C\u5BA0\u6E05\u7406\u8D85\u65F6");
    this.cleanupBlocked = false;
  }
  withDeadline(task, delay, message, signal, recoverable = false) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve(value);
      };
      const aborted = () => finish(new Error("\u684C\u5BA0\u542F\u52A8\u5DF2\u53D6\u6D88"));
      const timer = setTimeout(() => finish(new NativeStartError(message, recoverable)), delay);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      task.then((value) => finish(void 0, value), (error) => finish(error));
    });
  }
  set(state) {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch {
      }
    }
  }
  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => void 0);
    return pending;
  }
};
function hintText(value, limit) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}
function hintSessionId(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.length > 2048 || !value.trim()) return false;
  return value;
}

// src/index.ts
import { z as wire } from "zod";

// web/locale.js
function petLanguage(locale = "en") {
  return /^zh(?:-|$)/i.test(locale) ? "zh" : "en";
}
var zh = {
  companionPetThanks: "\u8C22\u8C22\u6478\u6478",
  companionNoActivity: "\u8FD9\u4E2A\u6A21\u6837\u6682\u65F6\u6CA1\u6709\u4E00\u8D77\u6D3B\u52A8\u7684\u52A8\u4F5C",
  companionInvite: "\u966A\u6211\u6D3B\u52A8\u4E00\u4E0B\uFF1F",
  companionTogether: "\u4E00\u8D77\u6D3B\u52A8",
  companionLater: "\u7A0D\u540E",
  companionQuietToday: "\u4ECA\u5929\u5B89\u9759",
  companionMode: "\u81EA\u4E3B\u966A\u4F34",
  companionOff: "\u5173\u95ED\uFF08\u505C\u6B62\u81EA\u4E3B\u6D3B\u52A8\uFF09",
  companionQuiet: "\u5B89\u9759\u966A\u4F34",
  companionInteractive: "\u4E92\u52A8\u966A\u4F34",
  companionResume: "\u6062\u590D\u9080\u8BF7",
  companionNew: "\u6162\u6162\u719F\u6089\u4F60",
  companionFamiliar: "\u719F\u6089\u62DB\u547C\u5DF2\u89E3\u9501",
  companionProgress: (n) => `\u4E00\u8D77\u76F8\u5904\u4E86 ${n} \u6B21`,
  companionUnavailable: "\u76F8\u5904\u8FDB\u5EA6\u6682\u65F6\u65E0\u6CD5\u4FDD\u5B58",
  companionDisabled: "\u5F00\u542F\u966A\u4F34\uFF0C\u7559\u4E0B\u76F8\u5904\u7684\u8BB0\u5FC6",
  companionBusy: "\u7B49\u5FD9\u5B8C\u518D\u4E00\u8D77\u73A9",
  companionPlaying: "\u966A\u4F60\u6D3B\u52A8\u4E00\u4F1A\u513F",
  companionPlayed: "\u4E00\u8D77\u6D3B\u52A8\uFF0C\u771F\u5F00\u5FC3",
  defaultName: "DeepSeek \u5927\u80A5\u9C7C",
  title: "DeepSeek \u5927\u80A5\u9C7C \xB7 Harness",
  words: { neutral: "\u5E73\u9759", happy: "\u5F00\u5FC3", wink: "\u7728\u773C", love: "\u559C\u6B22", shy: "\u5BB3\u7F9E", surprised: "\u60CA\u8BB6", angry: "\u751F\u6C14", sad: "\u96BE\u8FC7", sleepy: "\u72AF\u56F0", thinking: "\u601D\u8003", smug: "\u5F97\u610F", pout: "\u561F\u5634", worried: "\u62C5\u5FC3", determined: "\u8BA4\u771F", flustered: "\u614C\u5F20", scared: "\u5BB3\u6015", excited: "\u671F\u5F85", cry: "\u5927\u54ED", confused: "\u7591\u60D1", stand: "\u7AD9\u8D77", jump: "\u8DF3", hop: "\u5C0F\u8DF3", look: "\u5F20\u671B", turn: "\u8F6C\u8EAB", nod: "\u70B9\u5934", shake: "\u6447\u5934", spin: "\u8F6C\u5708", sit: "\u5750\u4E0B", sleep: "\u7761\u89C9", dizzy: "\u6655", walk: "\u6563\u6B65", run: "\u8DD1", wave: "\u62DB\u624B", bow: "\u97A0\u8EAC", shiver: "\u53D1\u6296", flap: "\u6251\u817E", dance: "\u8DF3\u821E" },
  settingFailed: "\u8BBE\u7F6E\u672A\u80FD\u4FDD\u5B58",
  settingFailedBody: "\u8BF7\u56DE\u5230 Harness \u68C0\u67E5\u63D2\u4EF6\u8BBE\u7F6E\u3002",
  sessionUnavailable: "\u4F1A\u8BDD\u5C1A\u672A\u5C31\u7EEA",
  sessionUnavailableBody: "\u8BF7\u5148\u56DE\u5230 Harness \u6253\u5F00\u8FD9\u4E2A\u4F1A\u8BDD\uFF0C\u7136\u540E\u518D\u53D1\u9001\u6D88\u606F\u3002",
  messageFailed: "\u6D88\u606F\u672A\u80FD\u53D1\u9001",
  messageFailedBody: "\u8BF7\u56DE\u5230 Harness \u68C0\u67E5\u4F1A\u8BDD\u72B6\u6001\u3002",
  replyBody: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  progressBody: "\u672C\u8F6E\u56DE\u590D\u5DF2\u751F\u6210\uFF0C\u76EE\u6807\u4ECD\u5728\u8FDB\u884C\u4E2D\u3002",
  completeBody: "\u76EE\u6807\u5DF2\u5B8C\u6210\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  goalPausedBody: "\u76EE\u6807\u5DF2\u6682\u505C\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  goalBlockedBody: "\u76EE\u6807\u9047\u5230\u963B\u788D\uFF0C\u56DE\u5230\u4F1A\u8BDD\u67E5\u770B\u3002",
  stoppedBody: "\u5148\u505C\u5728\u8FD9\u91CC\uFF0C\u968F\u65F6\u7EE7\u7EED\u3002",
  interruptedBody: "\u8FD9\u6BB5\u4EFB\u52A1\u4E2D\u65AD\u4E86\uFF0C\u966A\u4F60\u56DE\u53BB\u770B\u770B\u3002",
  demoTitle: "\u5DE5\u4F5C\u7684\u65F6\u5019\uFF0C\n\u5927\u80A5\u9C7C\u966A\u7740\u3002",
  demoIntro: "\u4F4F\u5728\u684C\u9762\u4E0A\u7684 DeepSeek \u5927\u80A5\u9C7C\u3002\n\u70B9\u70B9\u5979\u3001\u62D6\u7740\u5979\u8D70\uFF0C\u6216\u548C\u5979\u8BF4\u53E5\u8BDD\u3002",
  demoStatus: "\u6D4F\u89C8\u5668\u6F14\u793A \xB7 \u6A21\u62DF Harness \u4E8B\u4EF6",
  demoHint: "\u684C\u9762\u63D2\u4EF6\u4F1A\u8BA2\u9605\u771F\u5B9E\u4EFB\u52A1\uFF0C\u65E0\u9700\u53E6\u586B API Key\u3002",
  demoButtons: { thinking: "\u601D\u8003", talking: "\u56DE\u590D", working: "\u5DE5\u4F5C", waiting: "\u7B49\u4F60\u786E\u8BA4", happy: "\u4EFB\u52A1\u5B8C\u6210", error: "\u9047\u5230\u95EE\u9898", idle: "\u7A7A\u95F2", long: "\u957F\u56DE\u590D", background: "\u540E\u53F0\u5B8C\u6210" },
  demoSession: "\u6F14\u793A\u4F1A\u8BDD",
  demoOther: "\u53E6\u4E00\u4E2A\u60F3\u6CD5",
  demoPrompt: "\u8BA9\u89D2\u8272\u5728\u601D\u8003\u4E0E\u56DE\u590D\u65F6\u505A\u51FA\u5BF9\u5E94\u7684\u52A8\u4F5C",
  demoOtherPrompt: "\u91CD\u505A\u89D2\u8272\u83DC\u5355\u4E0E\u4F1A\u8BDD\u9009\u62E9\uFF0C\u8BA9\u5B83\u66F4\u50CF\u4F19\u4F34",
  demoTexts: { thinking: "\u8BA9\u6211\u60F3\u4E00\u60F3\uFF0C\u600E\u6837\u628A\u8FD9\u4E2A\u529F\u80FD\u505A\u597D\u2026", talking: "\u6211\u60F3\u5230\u4E86\u3002\u8BA9\u601D\u8003\u3001\u8BF4\u8BDD\u4E0E\u5DE5\u4F5C\u5404\u6709\u81EA\u5DF1\u7684\u52A8\u4F5C\uFF0C\u5C31\u80FD\u4E00\u773C\u770B\u51FA\u8FD9\u6BB5\u5BF9\u8BDD\u5728\u505A\u4EC0\u4E48\u3002", working: "\u6B63\u5728\u770B\u6587\u4EF6 \xB7 src/index.ts", waiting: "\u4E0B\u4E00\u6B65\u9700\u8981\u4F60\u786E\u8BA4\u3002\u771F\u5B9E\u63D2\u4EF6\u4F1A\u5F15\u5BFC\u4F60\u56DE\u5230 Harness\u3002", happy: "\u4EFB\u52A1\u5B8C\u6210\u5566\uFF01\u8981\u4E0D\u8981\u4F11\u606F\u4E00\u4E0B\uFF1F\u{1F433}", error: "\u4EFB\u52A1\u9047\u5230\u4E86\u95EE\u9898\uFF0C\u8BF7\u56DE\u5230 Harness \u67E5\u770B\u8BE6\u60C5\u3002" },
  demoLong: "\u52A8\u753B\u3001\u6C14\u6CE1\u548C\u4F1A\u8BDD\u7684\u5C55\u793A\u5DF2\u7ECF\u5206\u5F00\u4E86\u3002\n\n" + "\u601D\u8003\u548C\u5DE5\u5177\u8C03\u7528\u7531\u52A8\u4F5C\u8868\u8FBE\uFF0C\u6700\u7EC8\u56DE\u590D\u53EF\u4EE5\u5C55\u5F00\u9605\u8BFB\u3002\u957F\u5185\u5BB9\u4F1A\u5B8C\u6574\u4FDD\u7559\uFF0C\u4E0D\u4F1A\u5728\u4E00\u5343\u4E8C\u767E\u5B57\u5904\u622A\u65AD\u3002\n\n".repeat(35) + "\u6700\u540E\u4E00\u53E5\uFF1A\u8FD9\u4EFD\u56DE\u590D\u5B8C\u6574\u5730\u4FDD\u7559\u4E0B\u6765\u4E86\u3002",
  demoBackground: "\u540E\u53F0\u4F1A\u8BDD\u5DF2\u7ECF\u5B8C\u6210\uFF0C\u8FD9\u662F\u5B83\u7684\u6700\u7EC8\u56DE\u590D\u3002",
  demoReply: (text) => `\u6536\u5230\u300C${text}\u300D\uFF01\u8FD9\u662F\u6F14\u793A\u56DE\u590D\u3002\u771F\u5B9E\u63D2\u4EF6\u4F1A\u4F7F\u7528 Harness \u7684\u6A21\u578B\u3002`,
  labels: { idle: "\u5728\u8FD9\u91CC\u966A\u4F60", thinking: "\u6B63\u5728\u601D\u8003", talking: "\u6B63\u5728\u56DE\u590D", working: "\u6B63\u5728\u5FD9", waiting: "\u7B49\u4F60\u786E\u8BA4", happy: "\u5B8C\u6210\u5566", error: "\u9700\u8981\u5173\u6CE8", sleeping: "\u4F11\u606F\u4E2D" },
  stage: "\u684C\u5BA0\u6D3B\u52A8\u533A\u57DF",
  dismiss: "\u6536\u8D77\u6C14\u6CE1",
  reveal: "\u7ACB\u5373\u663E\u793A",
  expand: "\u5C55\u5F00\u5B8C\u6574\u56DE\u590D \u2197",
  back: "\u56DE\u5230\u4F1A\u8BDD \u2197",
  readerClose: "\u6536\u8D77\u5B8C\u6574\u56DE\u590D",
  conversationsCaption: "\u4E00\u8D77\u5DE5\u4F5C\u7684\u7247\u6BB5",
  conversationsTitle: "\u8FD9\u6B21\uFF0C\u966A\u54EA\u4E00\u6BB5\uFF1F",
  conversationsClose: "\u6536\u8D77\u5BF9\u8BDD\u6C14\u6CE1",
  conversationsIntro: "\u56FA\u5B9A\u966A\u7740\u4F60\u9009\u7684\u8FD9\u6BB5\u3002\u540E\u53F0\u7EE7\u7EED\u5DE5\u4F5C\uFF0C\u56DE\u590D\u7559\u5728\u8FD9\u91CC\uFF0C\u9047\u5230\u8981\u7D27\u4E8B\u5C31\u53EB\u4F60\u3002",
  all: "\u5168\u90E8",
  pending: "\u5F85\u67E5\u770B",
  searchPlaceholder: "\u627E\u63D0\u95EE\u3001\u9879\u76EE\u6216\u7F16\u53F7\u2026",
  searchLabel: "\u641C\u7D22\u4F1A\u8BDD",
  switchConversation: "\u5207\u6362\u5F53\u524D\u5BF9\u8BDD",
  openCurrent: "\u6253\u5F00\u5F53\u524D\u4F1A\u8BDD \u2197",
  chatTitle: "\u6211\u5728\uFF0C\u6162\u6162\u8BF4\u3002",
  chatClose: "\u5173\u95ED\u804A\u5929",
  changeConversation: "\u6362\u4E00\u6BB5 \u203A",
  readFull: "\u8BFB\u5B8C\u6574\u56DE\u590D \u2197",
  interact: "\u548C\u89D2\u8272\u4E92\u52A8",
  wave: "\u6253\u4E2A\u62DB\u547C",
  cheer: "\u7ED9\u6211\u6253\u6C14",
  messagePlaceholder: "\u63A5\u7740\u8FD9\u6BB5\u5BF9\u8BDD\u8BF4\u70B9\u4EC0\u4E48\u2026",
  messageLabel: "\u6D88\u606F",
  sendHint: "\u2318 / Ctrl + Enter \u53D1\u9001",
  send: "\u634E\u7ED9\u8FD9\u6BB5\u5BF9\u8BDD \u2197",
  retrySend: "\u91CD\u8BD5\u53D1\u9001 \u2197",
  sending: "\u53D1\u9001\u4E2D\u2026",
  sendAccepted: "\u5DF2\u8FDB\u5165\u8FD9\u6BB5\u4F1A\u8BDD\u7684\u6536\u4EF6\u961F\u5217\u3002\u56DE\u590D\u5C06\u7EE7\u7EED\u663E\u793A\u5728\u8FD9\u91CC\u3002",
  sendFailure: (code) => `\u53D1\u9001\u672A\u786E\u8BA4\uFF1A${chatFailure(code, "zh")}\u3002\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF0C\u53EF\u91CD\u8BD5\u3002`,
  companion: "\u684C\u4E0A\u7684\u5C0F\u4F19\u4F34",
  menuClose: "\u6536\u8D77\u4F19\u4F34\u83DC\u5355",
  appearance: "\u6362\u4E2A\u6A21\u6837",
  appearanceHint: "\u89D2\u8272 \xB7 \u914D\u8272 \xB7 \u52A8\u4F5C",
  say: "\u8BF4\u53E5\u8BDD",
  sayHint: "\u63A5\u7740\u4F60\u7684\u4F1A\u8BDD\u804A",
  roam: "\u6563\u6563\u6B65",
  roamHint: "\u81EA\u5728\u8D70\u52A8",
  sleep: "\u6B47\u4E00\u4F1A",
  sleepHint: "\u5FD9\u8D77\u6765\u4F1A\u9192",
  notices: "\u63D0\u9192\u6211",
  noticesHint: "\u8981\u7D27\u4E8B\u4E0D\u6F0F\u6389",
  sound: "\u5C0F\u5C0F\u58F0",
  soundHint: "\u52A8\u4F5C\u4E0E\u8BF4\u8BDD\u97F3\u6548",
  hide: "\u6682\u65F6\u85CF\u8D77\u6765",
  source: "\u6E90\u7801 \xB7 AGPL \u2197",
  sourceHint: "\u4E0B\u8F7D\u5F53\u524D\u7248\u672C\u5B8C\u6574\u5BF9\u5E94\u6E90\u7801",
  characters: "\u89D2\u8272\u4E0E\u52A8\u753B",
  charactersClose: "\u5173\u95ED\u89D2\u8272\u9762\u677F",
  selectCharacter: "\u9009\u62E9\u89D2\u8272",
  character: "\u89D2\u8272",
  outfit: "\u914D\u8272 / \u6362\u88C5",
  characterScheme: "\u89D2\u8272\u914D\u8272",
  preview: "\u89D2\u8272\u52A8\u753B\u9884\u89C8",
  previewAction: "\u9884\u89C8\u52A8\u4F5C",
  play: "\u64AD\u653E\u52A8\u4F5C",
  useCharacter: "\u4F7F\u7528\u89D2\u8272",
  import: "\u5BFC\u5165\u89D2\u8272\u5305",
  remove: "\u5220\u9664",
  characterHint: "\u652F\u6301 Coopanion API 2 ZIP \u89D2\u8272\u5305\uFF1B\u89D2\u8272\u548C\u914D\u8272\u4F1A\u5728\u91CD\u542F\u540E\u4FDD\u7559\u3002",
  using: "\u6B63\u5728\u4F7F\u7528",
  useScheme: "\u4F7F\u7528\u8FD9\u4E2A\u914D\u8272",
  useOutfit: "\u4F7F\u7528\u8FD9\u4E2A\u642D\u914D",
  customOutfit: "\u81EA\u5B9A\u4E49\u642D\u914D",
  defaultScheme: "\u9ED8\u8BA4",
  imported: "\u5DF2\u5BFC\u5165\u3002\u9884\u89C8\u6EE1\u610F\u540E\u70B9\u51FB\u4F7F\u7528\u89D2\u8272\u3002",
  switched: "\u5DF2\u5207\u6362\uFF0C\u91CD\u542F\u540E\u4F1A\u4FDD\u7559\u8FD9\u4E2A\u89D2\u8272\u548C\u914D\u8272\u3002",
  removed: "\u5DF2\u5220\u9664\u672C\u5730\u89D2\u8272\u5305\u3002",
  packTooLarge: "\u89D2\u8272\u5305\u4E0D\u80FD\u8D85\u8FC7 128 MiB",
  noSession: "\u8FD8\u6CA1\u6709\u5BF9\u8BDD",
  noConversation: "\u8FD8\u6CA1\u6709\u4F1A\u8BDD",
  session: "\u4F1A\u8BDD",
  sessionReply: "\u4F1A\u8BDD\u56DE\u590D",
  focused: "\u5173\u6CE8",
  unread: "1 \u4EFD\u672A\u8BFB",
  notOpen: "\u672A\u6253\u5F00",
  connected: "\u6709\u4F1A\u8BDD\u76F8\u4F34",
  emptySearch: "\u6CA1\u627E\u5230\u8FD9\u6BB5\u5BF9\u8BDD\u3002\u8BD5\u8BD5\u63D0\u95EE\u91CC\u7684\u8BCD\u6216\u9879\u76EE\u540D\uFF1F",
  emptyPending: "\u90FD\u770B\u8FC7\u5566\uFF0C\u5B89\u5FC3\u505A\u624B\u8FB9\u7684\u4E8B\u3002",
  emptySessions: "\u8FD8\u6CA1\u6709\u53EF\u7528\u7684\u5BF9\u8BDD\u3002\u5148\u5728 Harness \u4E2D\u6253\u5F00\u4E00\u6BB5\u5BF9\u8BDD\uFF0C\u6211\u5C31\u80FD\u542C\u89C1\u5B83\u3002",
  noChat: "\u5148\u5728 Harness \u4E2D\u6253\u5F00\u4E00\u6BB5\u5BF9\u8BDD\uFF0C\u5C31\u53EF\u4EE5\u4ECE\u8FD9\u91CC\u548C\u6211\u8BF4\u8BDD\u3002",
  unavailableChat: "\u4F1A\u8BDD\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5728 Harness \u4E2D\u68C0\u67E5\u3002",
  sleepBusy: "\u6B63\u5728\u5FD9\uFF0C\u5B8C\u6210\u540E\u518D\u4F11\u606F",
  sleepWake: "\u6709\u65B0\u7684\u4EFB\u52A1\u4F1A\u81EA\u52A8\u9192\u6765",
  issueError: "\u4EFB\u52A1\u9047\u5230\u4E86\u95EE\u9898\uFF0C\u8BF7\u56DE\u5230 Harness \u67E5\u770B\u8BE6\u60C5\u3002",
  issueWaiting: "\u4EFB\u52A1\u6682\u65F6\u505C\u4E0B\u4E86\uFF0C\u8BF7\u56DE\u5230 Harness \u770B\u770B\u3002",
  timeUnknown: "\u65F6\u95F4\u672A\u8BB0\u5F55",
  petLabel: (name2) => `${name2}\uFF0C\u70B9\u51FB\u4E92\u52A8\uFF0C\u53CC\u51FB\u804A\u5929\uFF0C\u53F3\u952E\u83DC\u5355\uFF0C\u62D6\u52A8\u79FB\u52A8`,
  finalReply: (name2) => `${name2}\u7684\u6700\u7EC8\u56DE\u590D`,
  recent: (text) => `\u6700\u8FD1\uFF1A${text}`,
  chatTarget: (label) => `\u5F53\u524D\u5BF9\u8BDD\uFF1A${label}\u3002\u70B9\u51FB\u5207\u6362`,
  chatHelp: (label) => `\u6D88\u606F\u4EA4\u7ED9\u300C${label}\u300D\uFF0C\u5B8C\u6210\u540E\u53EA\u5C55\u793A\u6700\u7EC8\u56DE\u590D\u3002`,
  activity: (busy, unread) => `${busy} \u6BB5\u8FDB\u884C\u4E2D \xB7 ${unread} \u4EFD\u672A\u8BFB\u56DE\u590D`,
  authorCredit: (author, credits, license) => `\u4F5C\u8005\uFF1A${author} \xB7 ${credits} \xB7 \u8BB8\u53EF\uFF1A${license}`,
  unknownAuthor: "\u672A\u6CE8\u660E",
  builtinLicense: "\u4EE3\u7801 AGPL-3.0-or-later\uFF1B\u7D20\u6750\u89C1\u6743\u5229\u58F0\u660E",
  authorLicense: "\u7531\u89D2\u8272\u4F5C\u8005\u6CE8\u660E",
  operationError: (detail) => `\u64CD\u4F5C\u672A\u5B8C\u6210\uFF1A${detail}`,
  bodyError: (detail) => `\u89D2\u8272\u8FD0\u884C\u5931\u8D25\uFF1A${detail}`,
  builtinError: (detail) => `\u65E0\u6CD5\u52A0\u8F7D\u5185\u7F6E\u89D2\u8272\uFF1A${detail}`,
  previewError: (detail) => `\u9884\u89C8\u5931\u8D25\uFF1A${detail}`,
  restoreError: (detail) => `\u5DF2\u6062\u590D\u5185\u7F6E\u5927\u80A5\u9C7C\uFF1A${detail}`,
  loadError: (detail) => `\u89D2\u8272\u52A0\u8F7D\u5931\u8D25\uFF1A${detail}`,
  trayDisplay: "\u79FB\u5230\u663E\u793A\u5668",
  display: "\u663E\u793A\u5668",
  trayOpen: "\u56DE\u5230\u5F53\u524D\u4F1A\u8BDD",
  traySwitch: "\u5207\u6362\u966A\u4F34\u4F1A\u8BDD",
  trayChat: "\u8BF4\u53E5\u8BDD",
  trayCharacters: "\u89D2\u8272\u4E0E\u914D\u8272",
  trayRoam: "\u81EA\u5728\u8D70\u52A8",
  traySleep: "\u4F11\u606F\u4E00\u4E0B\uFF08\u65B0\u4EFB\u52A1\u4F1A\u5524\u9192\uFF09",
  trayNotices: "\u4EFB\u52A1\u63D0\u9192",
  traySound: "\u52A8\u4F5C\u4E0E\u8BF4\u8BDD\u97F3\u6548",
  trayShow: "\u663E\u793A\u4F19\u4F34",
  trayQuit: "\u5173\u95ED\u684C\u5BA0",
  trayNeeds: " \xB7 \u9700\u8981\u4F60",
  trayUnread: (n) => ` \xB7 ${n} \u4EFD\u672A\u8BFB`,
  trayPending: (unread, pending) => `\u5F85\u67E5\u770B \xB7 ${unread} \u4EFD\u56DE\u590D \xB7 ${pending} \u6BB5\u9700\u8981\u4F60`,
  trayTooltip: (name2, mood, label, busy, pending, unread) => `${name2} \xB7 ${mood}
\u5173\u6CE8\uFF1A${label}
${busy} \u6BB5\u8FDB\u884C\u4E2D \xB7 ${pending} \u6BB5\u9700\u8981\u4F60 \xB7 ${unread} \u4EFD\u672A\u8BFB\u56DE\u590D`
};
var en = {
  companionPetThanks: "Thanks for the gentle stroke",
  companionNoActivity: "This character has no shared activity yet",
  companionInvite: "Shall we play for a moment?",
  companionTogether: "Play together",
  companionLater: "Later",
  companionQuietToday: "Quiet today",
  companionMode: "Companionship",
  companionOff: "Off (no autonomous activity)",
  companionQuiet: "Quiet",
  companionInteractive: "Interactive",
  companionResume: "Resume invitations",
  companionNew: "Getting to know you",
  companionFamiliar: "Familiar greeting unlocked",
  companionProgress: (n) => `${n} shared moments`,
  companionUnavailable: "Shared moments cannot be saved right now",
  companionDisabled: "Enable companionship to remember shared moments",
  companionBusy: "Let\u2019s play after work",
  companionPlaying: "Playing together",
  companionPlayed: "That was fun together",
  defaultName: "DeepSeek Whale",
  title: "DeepSeek Whale \xB7 Harness",
  words: { neutral: "Neutral", happy: "Happy", wink: "Wink", love: "Love", shy: "Shy", surprised: "Surprised", angry: "Angry", sad: "Sad", sleepy: "Sleepy", thinking: "Thinking", smug: "Smug", pout: "Pout", worried: "Worried", determined: "Determined", flustered: "Flustered", scared: "Scared", excited: "Excited", cry: "Cry", confused: "Confused", stand: "Stand", jump: "Jump", hop: "Hop", look: "Look around", turn: "Turn", nod: "Nod", shake: "Shake head", spin: "Spin", sit: "Sit", sleep: "Sleep", dizzy: "Dizzy", walk: "Walk", run: "Run", wave: "Wave", bow: "Bow", shiver: "Shiver", flap: "Flap", dance: "Dance" },
  settingFailed: "Settings were not saved",
  settingFailedBody: "Open Harness to check the plugin settings.",
  sessionUnavailable: "Conversation not ready",
  sessionUnavailableBody: "Open this conversation in Harness before sending a message.",
  messageFailed: "Message was not sent",
  messageFailedBody: "Open Harness to check the conversation state.",
  replyBody: "This turn\u2019s reply is ready. Open the conversation to read it.",
  progressBody: "This turn\u2019s reply is ready. The goal is still in progress.",
  completeBody: "Goal completed. Open the conversation to read it.",
  goalPausedBody: "The goal is paused. Open the conversation for details.",
  goalBlockedBody: "The goal is blocked. Open the conversation for details.",
  stoppedBody: "Paused here. Continue whenever you are ready.",
  interruptedBody: "This task was interrupted. Open the conversation to check it.",
  demoTitle: "While you work,\nWhale keeps you company.",
  demoIntro: "Your DeepSeek Whale desktop companion.\nSay hello, drag her around, or continue a conversation.",
  demoStatus: "Browser demo \xB7 Simulated Harness events",
  demoHint: "The desktop plugin follows real tasks. No extra API key is needed.",
  demoButtons: { thinking: "Think", talking: "Reply", working: "Work", waiting: "Approval", happy: "Finished", error: "Error", idle: "Idle", long: "Long reply", background: "Background reply" },
  demoSession: "Demo conversation",
  demoOther: "Another idea",
  demoPrompt: "Match the character\u2019s actions to thinking and replying",
  demoOtherPrompt: "Make the character menu and conversation picker feel like a companion",
  demoTexts: { thinking: "Let me think about how to do this\u2026", talking: "Thinking, replying and working each have their own actions, so you can see what this conversation is doing.", working: "Reading files \xB7 src/index.ts", waiting: "The next step needs your approval. The installed plugin opens Harness.", happy: "Finished! Shall we take a rest? \u{1F433}", error: "This task needs attention. Open Harness for details." },
  demoLong: "Animation, bubbles and conversations are presented separately.\n\n" + "Actions show thinking and tool use. Final replies open in full and remain complete, including long content.\n\n".repeat(35) + "The complete reply has been preserved.",
  demoBackground: "The background conversation finished. Here is its final reply.",
  demoReply: (text) => `Received \u201C${text}\u201D! This is a demo reply. The installed plugin uses the Harness model.`,
  labels: { idle: "Here for you", thinking: "Thinking", talking: "Replying", working: "Working", waiting: "Waiting for you", happy: "Finished", error: "Needs attention", sleeping: "Resting" },
  stage: "Desktop pet activity area",
  dismiss: "Dismiss bubble",
  reveal: "Show now",
  expand: "Read full reply \u2197",
  back: "Back to conversation \u2197",
  readerClose: "Close full reply",
  conversationsCaption: "Working together",
  conversationsTitle: "Which conversation shall we join?",
  conversationsClose: "Close conversations",
  conversationsIntro: "Stay with the conversation you choose. Background work continues, replies stay here, and important requests get your attention.",
  all: "All",
  pending: "Inbox",
  searchPlaceholder: "Find a prompt, project or ID\u2026",
  searchLabel: "Search conversations",
  switchConversation: "Switch current conversation",
  openCurrent: "Open current conversation \u2197",
  chatTitle: "I\u2019m here. Take your time.",
  chatClose: "Close chat",
  changeConversation: "Switch \u203A",
  readFull: "Read full reply \u2197",
  interact: "Interact with the character",
  wave: "Say hello",
  cheer: "Cheer me on",
  messagePlaceholder: "Continue this conversation\u2026",
  messageLabel: "Message",
  sendHint: "\u2318 / Ctrl + Enter to send",
  send: "Send to this conversation \u2197",
  retrySend: "Retry send \u2197",
  sending: "Sending\u2026",
  sendAccepted: "Accepted into this conversation\u2019s inbox. Replies will appear here.",
  sendFailure: (code) => `Send unconfirmed: ${chatFailure(code, "en")}. Draft kept; you can retry.`,
  companion: "Your desktop companion",
  menuClose: "Close companion menu",
  appearance: "Change appearance",
  appearanceHint: "Character \xB7 Colours \xB7 Actions",
  say: "Say something",
  sayHint: "Continue your conversation",
  roam: "Take a walk",
  roamHint: "Roam freely",
  sleep: "Take a rest",
  sleepHint: "Wake when work starts",
  notices: "Keep me posted",
  noticesHint: "Remember important requests",
  sound: "A little sound",
  soundHint: "Action and reply sounds",
  hide: "Hide for now",
  source: "Source \xB7 AGPL \u2197",
  sourceHint: "Download the complete source for this version",
  characters: "Characters and animation",
  charactersClose: "Close character panel",
  selectCharacter: "Select character",
  character: "Character",
  outfit: "Colours / Outfit",
  characterScheme: "Character colours",
  preview: "Character animation preview",
  previewAction: "Preview action",
  play: "Play action",
  useCharacter: "Use character",
  import: "Import character pack",
  remove: "Delete",
  characterHint: "Coopanion API 2 ZIP packs. Characters and colours survive restarts.",
  using: "In use",
  useScheme: "Use these colours",
  useOutfit: "Use this outfit",
  customOutfit: "Custom outfit",
  defaultScheme: "Default",
  imported: "Imported. Preview the character, then choose Use character.",
  switched: "Changed. This character and its colours will survive restarts.",
  removed: "Local character pack deleted.",
  packTooLarge: "Character packs cannot exceed 128 MiB",
  noSession: "No conversation yet",
  noConversation: "No conversation yet",
  session: "Conversation",
  sessionReply: "Conversation reply",
  focused: "Focused",
  unread: "1 unread reply",
  notOpen: "Not open",
  connected: "Conversation connected",
  emptySearch: "No matching conversation. Try a word from the prompt or project name.",
  emptyPending: "All read. Carry on with your work.",
  emptySessions: "No conversation is available. Open one in Harness to get started.",
  noChat: "Open a conversation in Harness to chat here.",
  unavailableChat: "The conversation service is unavailable. Check Harness.",
  sleepBusy: "Working now. Rest when it is done.",
  sleepWake: "Wake automatically when new work starts.",
  issueError: "The task needs attention. Open Harness for details.",
  issueWaiting: "The task paused. Open Harness to check the next step.",
  timeUnknown: "Time not recorded",
  petLabel: (name2) => `${name2}, click to interact, double-click to chat, right-click for the menu, drag to move`,
  finalReply: (name2) => `Final reply from ${name2}`,
  recent: (text) => `Recent: ${text}`,
  chatTarget: (label) => `Current conversation: ${label}. Click to switch`,
  chatHelp: (label) => `Send to \u201C${label}\u201D. Each turn\u2019s full reply is kept here.`,
  activity: (busy, unread) => `${busy} active \xB7 ${unread} unread replies`,
  authorCredit: (author, credits, license) => `Author: ${author} \xB7 ${credits} \xB7 License: ${license}`,
  unknownAuthor: "Not specified",
  builtinLicense: "Code: AGPL-3.0-or-later; see artwork rights notice",
  authorLicense: "Specified by the character author",
  operationError: (detail) => `Operation failed: ${detail}`,
  bodyError: (detail) => `Character runtime failed: ${detail}`,
  builtinError: (detail) => `Cannot load the built-in character: ${detail}`,
  previewError: (detail) => `Preview failed: ${detail}`,
  restoreError: (detail) => `Built-in Whale restored: ${detail}`,
  loadError: (detail) => `Character failed to load: ${detail}`,
  trayDisplay: "Move to display",
  display: "Display",
  trayOpen: "Open current conversation",
  traySwitch: "Choose companion conversation",
  trayChat: "Say something",
  trayCharacters: "Characters and colours",
  trayRoam: "Roam freely",
  traySleep: "Rest (new work wakes the pet)",
  trayNotices: "Task reminders",
  traySound: "Action and reply sounds",
  trayShow: "Show companion",
  trayQuit: "Close desktop pet",
  trayNeeds: " \xB7 Needs attention",
  trayUnread: (n) => ` \xB7 ${n} unread`,
  trayPending: (unread, pending) => `Inbox \xB7 ${unread} replies \xB7 ${pending} need attention`,
  trayTooltip: (name2, mood, label, busy, pending, unread) => `${name2} \xB7 ${mood}
Focused: ${label}
${busy} active \xB7 ${pending} need attention \xB7 ${unread} unread replies`
};
function chatFailure(code, language) {
  const reasons = {
    "session/not-found": ["\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664", "conversation missing or deleted"],
    "session/writer-held": ["\u4F1A\u8BDD\u6B63\u7531\u5176\u4ED6\u8FDB\u7A0B\u5360\u7528", "conversation held by another writer"],
    "session/subagent-owned": ["\u5B50\u4EE3\u7406\u4F1A\u8BDD\u4E0D\u80FD\u76F4\u63A5\u7EED\u63A5", "subagent conversation cannot be continued here"],
    "session/model-unavailable": ["\u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u6A21\u578B", "no available model for this conversation"],
    "session/provider-credentials-unavailable": ["\u4F1A\u8BDD\u7684\u6A21\u578B\u51ED\u636E\u4E0D\u53EF\u7528", "model credentials unavailable"],
    "gateway/forbidden": ["\u6CA1\u6709\u6B64\u4F1A\u8BDD\u7684\u64CD\u4F5C\u6743\u9650", "permission denied"],
    "gateway/cancelled": ["\u63D0\u4EA4\u5DF2\u53D6\u6D88", "submission cancelled"],
    "coopanion/service-unavailable": ["\u4F1A\u8BDD\u670D\u52A1\u7F3A\u5931", "conversation service unavailable"],
    "coopanion/request-conflict": ["\u8BF7\u6C42\u8EAB\u4EFD\u4E0E\u539F\u6D88\u606F\u4E0D\u4E00\u81F4", "request identity conflicts with the original message"],
    "coopanion/no-receipt": ["\u672A\u6536\u5230\u63A5\u53D7\u56DE\u6267\uFF0C\u91CD\u8BD5\u4F1A\u590D\u7528\u539F\u8BF7\u6C42\u8EAB\u4EFD", "no acceptance receipt; retry uses the same request identity"],
    "session/agent-busy": ["\u4F1A\u8BDD\u6682\u65F6\u4E0D\u80FD\u63A5\u6536\u6D88\u606F", "conversation cannot accept the message now"]
  };
  return reasons[code]?.[language === "zh" ? 0 : 1] ?? (language === "zh" ? `\u4F1A\u8BDD\u6682\u4E0D\u53EF\u7528 (${code ?? "unknown"})` : `conversation unavailable (${code ?? "unknown"})`);
}

// web/text-scale.js
var TEXT_SCALES = Object.freeze([1, 1.25, 1.5]);
var DEFAULT_TEXT_SCALE = 1;

// web/companionship.js
var COMPANIONSHIP_MODES = ["off", "quiet", "interactive"];

// src/index.ts
var name = "dsh-coopanion";
var inject = ["agents"];
var Config = z2.object({
  size: z2.number().min(90).max(240).default(180).volatile(),
  textScale: z2.union(TEXT_SCALES.map((value) => z2.const(value))).default(DEFAULT_TEXT_SCALE).volatile(),
  roam: z2.boolean().default(true).volatile(),
  diagnostics: z2.boolean().default(false).volatile(),
  npcHome: z2.number().min(0.05).max(0.95).step(0.01).default(0.85).volatile(),
  npcRange: z2.number().min(0.1).max(0.6).step(0.01).default(0.3).volatile(),
  companionship: z2.union(COMPANIONSHIP_MODES.map((value) => z2.const(value))).default("off").volatile(),
  notifications: z2.boolean().default(true).volatile(),
  systemNotifications: z2.boolean().default(false).volatile(),
  reminders: z2.boolean().default(true).volatile(),
  reminderDelayMs: z2.number().step(1).min(6e4).max(864e5).default(6e5).volatile(),
  bubbleDurationMs: z2.number().min(2e3).max(6e4).default(12e3).volatile(),
  autoStart: z2.boolean().default(true).volatile(),
  electronPath: z2.string()
});
async function apply(ctx, config) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  await mountPet(ctx, config, new ElectronBridge());
}
async function mountPet(ctx, options, bridge) {
  const model = new PetModel();
  const chat = new ChatSubmission(ctx);
  const chatLifetime = new AbortController();
  ctx.effect(() => () => chatLifetime.abort());
  const preferences = {};
  let savePreference;
  ctx.inject(["settings"], (child) => {
    savePreference = (field, value) => child.settings.mutate("dsh-coopanion", [{ op: "set", path: [field], value }]);
  });
  const currentOptions = () => ({ size: options.size.get(), npcHome: options.npcHome.get(), npcRange: options.npcRange.get(), textScale: options.textScale.get(), roam: options.roam.get(), diagnostics: options.diagnostics.get(), companionship: options.companionship.get(), notifications: options.notifications.get(), bubbleDurationMs: options.bubbleDurationMs.get(), systemNotifications: options.systemNotifications.get(), reminders: options.reminders.get(), reminderDelayMs: options.reminderDelayMs.get(), electronPath: options.electronPath, locale, ...preferences });
  const controls = new PetControls(bridge, currentOptions);
  let locale;
  let clientLocale;
  let dedicatedLocale = false;
  let storedLocale;
  const syncLocale = () => {
    const preference = storedLocale?.();
    const next = preference ? petLanguage(preference) : clientLocale;
    if (next === locale) return;
    locale = next;
    controls.configure();
  };
  const adoptClientLocale = (value) => {
    clientLocale = petLanguage(value);
    syncLocale();
  };
  ctx.inject(["settings"], (child) => {
    const read = () => {
      const value = child.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === "locale")?.value;
      const preference = isRecord(value) && typeof value.preference === "string" ? value.preference.toLowerCase() : void 0;
      return preference === "zh" || preference === "en" ? preference : void 0;
    };
    storedLocale = read;
    child.effect(() => () => {
      if (storedLocale === read) storedLocale = void 0;
    });
    syncLocale();
  });
  let navigation;
  ctx.provide("coopanion", controls);
  const update = () => {
    const snapshot = model.snapshot();
    const available = !!ctx.get("sessionController") && !!ctx.get("sessionQuery");
    bridge.update({ ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session, chatAvailable: available })) });
  };
  let mounted = false;
  const notificationPrefs = () => notificationPreferencesSchema.parse({ notifications: currentOptions().notifications, systemNotifications: options.systemNotifications.get(), reminders: options.reminders.get(), reminderDelayMs: options.reminderDelayMs.get() });
  const syncNotifications = () => {
    if (!mounted) return;
    const snapshot = broker.snapshot();
    model.interactions(snapshot.interactions);
    bridge.notificationState?.(snapshot);
    update();
  };
  const broker = new NotificationBroker({ changed: syncNotifications, presentRole: (value, runtime) => bridge.presentRole?.(value, runtime) ?? false });
  broker.preferences(notificationPrefs());
  ctx.effect(() => () => broker.dispose());
  ctx.effect(() => controls.onState((state) => broker.runtime(state)));
  let questions;
  ctx.inject(["sessionProjections", "userQuestions"], (child) => {
    const sync = (session, live = true) => {
      try {
        const view = child.sessionProjections.snapshot(session, ["userQuestions"]).values.userQuestions;
        if (view) broker.questions(session, view, live);
      } catch (error) {
        child.logger.warn(`Question projection unavailable: ${String(error).slice(0, 300)}`);
      }
    };
    questions = sync;
    child.effect(() => () => {
      if (questions === sync) questions = void 0;
    });
    queueMicrotask(() => {
      if (!mounted || questions !== sync) return;
      for (const session of child.get("sessions")?.list() ?? ctx.agents.list().map((agent) => agent.session)) sync(session, false);
    });
  });
  let testSource;
  ctx.inject(["sessions", "sessionController"], (child) => {
    let source;
    const create = () => source ??= child.sessionController.create({ sessionId: SessionId2(`coopanion-notification-test-${randomUUID2()}`), cwd: process.cwd() }).then((value) => {
      const session = child.sessions.get(value.sessionId);
      if (!session) throw new Error("Notification test source unavailable");
      return session;
    }).catch((error) => {
      source = void 0;
      throw error;
    });
    testSource = create;
    child.effect(() => () => {
      if (testSource === create) testSource = void 0;
    });
  });
  let streamUpdate;
  ctx.effect(() => () => clearTimeout(streamUpdate));
  ctx.effect(() => () => controls.dispose());
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (model.settle()) update();
    }, 250);
    timer.unref();
    return () => clearInterval(timer);
  });
  ctx.on("settings/document-updated", (ns) => {
    if (ns === "dsh-coopanion") {
      broker.preferences(notificationPrefs());
      controls.configure();
    } else if (ns === "locale") syncLocale();
  });
  ctx.inject(["connection"], (child) => {
    const dispatch = async (endpoint, payload, signal) => {
      try {
        if (signal.aborted) throw new Error("\u8BF7\u6C42\u5DF2\u53D6\u6D88");
        if (endpoint === "locale") {
          const input = wire.object({ locale: wire.enum(["zh", "en"]) }).strict().parse(payload);
          dedicatedLocale = true;
          adoptClientLocale(input.locale);
          return { ok: true, value: { locale } };
        }
        if (endpoint === "status") {
          wire.object({}).strict().parse(payload);
          return { ok: true, value: controls.status() };
        }
        if (endpoint === "navigation") {
          wire.object({}).strict().parse(payload);
          const value = navigation && navigation.expires > Date.now() ? { sessionId: navigation.sessionId } : null;
          navigation = void 0;
          return { ok: true, value };
        }
        if (endpoint === "notification-state") {
          const input = notificationRequests.state.parse(payload);
          if (input.locale && !dedicatedLocale) adoptClientLocale(input.locale);
          return { ok: true, value: broker.snapshot() };
        }
        if (endpoint === "notification-claim") {
          const input = notificationRequests.claim.parse(payload);
          return { ok: true, value: broker.claim(input.clientId, input.generation) };
        }
        if (endpoint === "notification-receipt") {
          return { ok: true, value: { accepted: broker.receipt(notificationRequests.receipt.parse(payload)) } };
        }
        if (endpoint === "notification-snooze") {
          const input = notificationRequests.snooze.parse(payload);
          if (!broker.snooze(input.interactionId, input.generation)) throw new Error("\u5F85\u5904\u7406\u8BF7\u6C42\u5DF2\u53D8\u5316\u6216\u63D0\u9192\u6682\u4E0D\u53EF\u7528");
          return { ok: true, value: { accepted: true } };
        }
        if (endpoint === "notification-test") {
          const input = notificationRequests.test.parse(payload), state = broker.snapshot().runtime, prefs = notificationPrefs();
          if (!testSource || state.phase !== "running" || state.visible || state.suspended || state.visibilityRevision === 0 || input.generation !== state.generation || !prefs.notifications || !prefs.systemNotifications) throw new Error("\u8BF7\u542F\u52A8\u5E76\u9690\u85CF\u89D2\u8272\uFF0C\u5F00\u542F\u7CFB\u7EDF\u901A\u77E5\u540E\u6D4B\u8BD5");
          const session = await testSource();
          if (signal.aborted) throw new Error("\u8BF7\u6C42\u5DF2\u53D6\u6D88");
          const latest = broker.snapshot().runtime;
          if (latest.generation !== state.generation || latest.visibilityRevision !== state.visibilityRevision || latest.phase !== "running" || latest.visible || latest.suspended) throw new Error("\u684C\u5BA0\u72B6\u6001\u5DF2\u53D8\u5316");
          const turn = session.snapshotEvents().findLast((event2) => event2.type === "turn/start")?.data?.turn ?? 0;
          session.append("turn/start", { turn: turn + 1 });
          session.append("turn/end", { turn: turn + 1, reason: { kind: "completed" } });
          const event = session.snapshotEvents().at(-1);
          const claim = broker.claim(input.clientId, input.generation, noticeId(session.id, turn + 1, event.seq, "reply", "initial"));
          if (!claim) throw new Error("\u6D4B\u8BD5\u901A\u77E5\u672A\u80FD\u9886\u53D6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
          return { ok: true, value: claim };
        }
        if (endpoint !== "control") throw new Error("\u672A\u77E5\u7684\u684C\u5BA0\u64CD\u4F5C");
        const { command } = wire.object({ command: wire.enum(["start", "show", "hide", "restart", "stop", "characters"]) }).strict().parse(payload);
        return { ok: true, value: await controls.command(command) };
      } catch (error) {
        return { ok: false, error: { code: "coopanion/rejected", message: String(error instanceof Error ? error.message : error).slice(0, 600), details: {} } };
      }
    };
    for (const endpoint of ["status", "control", "navigation", "locale", ...notificationEndpoints]) {
      child.effect(() => child.connection.fetch.register({
        path: `/api/coopanion/${endpoint}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          const parsed = wire.object({ type: wire.literal("client-request"), rpcId: wire.string().min(1).max(128), method: wire.literal(`coopanion/${endpoint}`), payload: wire.unknown() }).strict().safeParse(await request.json().catch(() => void 0));
          if (!parsed.success) return Response.json({ error: "Invalid desktop pet request" }, { status: 400 });
          return Response.json({ type: "server-response", rpcId: parsed.data.rpcId, result: await dispatch(endpoint, parsed.data.payload, request.signal) });
        }
      }));
    }
  });
  const restoreSession = (session, running = ctx.agents.list().some((agent) => agent.session.id === session.id && agent.status === "running")) => {
    model.restore(session);
    if (running) model.running(session);
    else model.idle(session.id);
    broker.restore(session);
    questions?.(session, false);
  };
  ctx.inject(["sessions"], (child) => {
    for (const session of child.sessions.list()) restoreSession(session);
    syncNotifications();
    update();
  });
  for (const agent of ctx.agents.list()) restoreSession(agent.session, agent.status === "running");
  ctx.inject(["sessionController", "sessionQuery"], (child) => {
    const lifetime = new AbortController();
    child.effect(() => () => lifetime.abort());
    void (async () => {
      const { items } = await child.sessionController.list({}, lifetime.signal);
      for (const item of items.filter((item2) => item2.origin !== "subagent").slice(0, 100)) {
        if (lifetime.signal.aborted) return;
        const observed = await child.sessionQuery.observeSession(item.sessionId, { signal: lifetime.signal });
        try {
          const source = { id: observed.header.id, header: observed.header, snapshotEvents: () => observed.events };
          model.restore(source);
          broker.restore(source, observed.projections?.values.userQuestions);
          if (!ctx.agents.list().some((agent) => agent.session.id === item.sessionId && agent.status === "running")) model.idle(item.sessionId);
        } finally {
          observed[Symbol.dispose]();
        }
      }
      syncNotifications();
      update();
    })().catch((error) => {
      if (!lifetime.signal.aborted) child.logger.warn(`Desktop pet history unavailable: ${String(error).slice(0, 300)}`);
    });
    update();
  });
  ctx.on("session/created", (session) => {
    restoreSession(session);
    syncNotifications();
    update();
  });
  ctx.on("agent/created", ({ agent }) => {
    restoreSession(agent.session, agent.status === "running");
    syncNotifications();
    update();
    return void 0;
  });
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "running") model.running(agent.session);
    else model.idle(agent.session.id);
    update();
  });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (!model.stream(agent.session, frame) || streamUpdate) return;
    streamUpdate = setTimeout(() => {
      streamUpdate = void 0;
      update();
    }, 40);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    model.idle(agent.session.id);
    model.detached(agent.session.id);
    update();
  });
  ctx.on("session/event", (session, event) => {
    broker.consume(session, event);
    model.consume(session, event);
    questions?.(session);
    syncNotifications();
    update();
  });
  ctx.on("session/disposed", (session) => {
    broker.remove(session.id);
    model.idle(session.id);
    model.detached(session.id);
    update();
  });
  ctx.inject(["userQuestions"], (child) => {
    child.on("user-questions/request", async (request, next) => {
      const session = request.agent?.session;
      if (!session || session.header.origin === "subagent") return next();
      model.observe(session);
      const events = session.snapshotEvents();
      const callId = request.wait?.callId;
      const origin = callId ? events.findLast((event) => event.type === "tool/call" && event.data.callId === callId || event.type === "tool/ptc-dispatch" && event.data.subCallId === callId) : void 0;
      const anchor = origin ?? events.at(-1);
      const turnEvent = events.findLast((event) => event.type === "turn/start");
      const finish = broker.question(session, { nativeId: origin && callId ? callId : randomUUID2(), turn: turnEvent?.type === "turn/start" ? turnEvent.data.turn : 0, seq: anchor?.seq ?? 0, preview: request.questions.map((q) => q.question).join("\n"), signal: request.signal, source: origin ? "event" : "runtime" });
      questions?.(session);
      syncNotifications();
      try {
        return await next();
      } finally {
        questions?.(session);
        finish();
        syncNotifications();
      }
    }, { prepend: true });
  });
  const onAction = (action) => {
    if (!isRecord(action)) return;
    if (action.type === "notification-snooze") {
      const input = notificationRequests.snooze.safeParse({ interactionId: action.interactionId, generation: action.generation });
      const ok = input.success && broker.snooze(input.data.interactionId, input.data.generation);
      if (typeof action.interactionId === "string") bridge.snoozeResult?.(action.interactionId, ok, ok ? void 0 : "\u5F85\u5904\u7406\u8BF7\u6C42\u5DF2\u53D8\u5316\u6216\u63D0\u9192\u6682\u4E0D\u53EF\u7528");
      syncNotifications();
      return;
    }
    if (action.type === "preference" && ((action.field === "roam" || action.field === "notifications") && typeof action.value === "boolean" || action.field === "companionship" && COMPANIONSHIP_MODES.includes(action.value))) {
      const field = action.field, value = action.value;
      void (async () => {
        try {
          if (savePreference) await savePreference(field, value);
          else Object.assign(preferences, { [field]: value });
          broker.preferences(notificationPrefs());
          controls.configure();
        } catch {
          bridge.notify({ title: "\u8BBE\u7F6E\u672A\u80FD\u4FDD\u5B58", body: "\u8BF7\u56DE\u5230 Harness \u68C0\u67E5\u63D2\u4EF6\u8BBE\u7F6E\u3002", sessionId: model.snapshot().sessionId ?? "" });
        }
      })();
      return;
    }
    if (action.type === "select" && typeof action.sessionId === "string") {
      model.select(action.sessionId);
      update();
      return;
    }
    if (action.type === "read" && typeof action.resultId === "string") {
      if (model.read(action.resultId)) update();
      return;
    }
    if (action.type === "open-session" && typeof action.sessionId === "string") {
      if (!model.select(action.sessionId)) return;
      navigation = { sessionId: action.sessionId, expires: Date.now() + 3e4 };
      bridge.focusHarness?.();
      update();
      return;
    }
    if (action.type !== "chat") return;
    void chat.submit(action, chatLifetime.signal).then((receipt) => {
      if (receipt) bridge.chatResult?.(receipt);
      update();
    });
  };
  ctx.effect(() => {
    bridge.onAction(onAction);
    return () => bridge.removeAction(onAction);
  });
  if (bridge instanceof ElectronBridge) {
    const onFailure = (error) => ctx.logger.warn(error.message);
    ctx.effect(() => {
      bridge.on("failure", onFailure);
      return () => bridge.off("failure", onFailure);
    });
  }
  mounted = true;
  syncNotifications();
  update();
  if (options.autoStart.get()) {
    void controls.command("start").then((status) => {
      if (status.error) ctx.logger.warn(status.error);
    }, (error) => ctx.logger.warn(String(error).slice(0, 600)));
  }
}
export {
  Config,
  apply,
  inject,
  mountPet,
  name
};
//# sourceMappingURL=index.js.map
