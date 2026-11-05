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
        const old = [...this.sessions.keys()].find((id) => id !== this.selected);
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
  detached(id) {
    const task = this.tasks.get(id);
    if (task) task.stream = void 0;
  }
  idle(id) {
    const item = this.sessions.get(id), task = this.tasks.get(id);
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
    for (const [id, task] of this.tasks) {
      if (!task.celebrateUntil || this.now() < task.celebrateUntil) continue;
      task.celebrateUntil = 0;
      const item = this.sessions.get(id);
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
              const id = `${item.id}:${event.data.turn}:${event.seq}`;
              this.results.set(id, { id, sessionId: item.id, text, time: event.time, read: !live });
              item.reply = text;
              item.replyId = id;
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
  approval(id, tool, token = Symbol()) {
    const item = this.sessions.get(id);
    if (!item) return;
    const task = this.tasks.get(id);
    task.active = true;
    task.approvals.add(token);
    task.celebrateUntil = 0;
    this.present(item, "waiting", `${toolLabel(tool)}\u524D\u9700\u8981\u4F60\u786E\u8BA4\uFF0C\u8BF7\u56DE\u5230 Harness\u3002`);
    return { title: `${item.label} \xB7 \u7B49\u4F60\u786E\u8BA4`, body: item.text, sessionId: id, kind: "task" };
  }
  approvalSettled(id, token) {
    const item = this.sessions.get(id);
    const task = this.tasks.get(id);
    if (!item || !task?.active) return;
    if (token ? !task.approvals.delete(token) : !task.approvals.size) return;
    if (!token) task.approvals.clear();
    if (!task.approvals.size && item.mood === "waiting") {
      this.present(item, task.tools.size ? "working" : "thinking", task.tools.size ? toolLabel(task.tools.values().next().value) : "\u786E\u8BA4\u5DF2\u5904\u7406\uFF0C\u7B49\u5F85\u4EFB\u52A1\u7EE7\u7EED\u2026");
    }
  }
  /** Public request state can outlive a turn; viewing or reading never removes its waiting entrance. */
  interactions(values) {
    for (const [id, task] of this.tasks) {
      const wasPending = task.requests.size > 0;
      const pending = values.filter((value) => value.sessionId === id && value.state !== "settled");
      task.requests = new Set(pending.map((value) => value.id));
      task.questions = new Set(pending.filter((value) => value.kind === "question").map((value) => value.id));
      const item = this.sessions.get(id);
      if (pending.length) {
        delete item.completion;
        task.celebrateUntil = 0;
        this.present(item, "waiting", pending.some((value) => value.kind === "question") ? "\u6709\u4E2A\u95EE\u9898\u60F3\u95EE\u4F60\uFF0C\u8BF7\u56DE\u5230 Harness \u770B\u770B\u3002" : "\u4E0B\u4E00\u6B65\u9700\u8981\u4F60\u786E\u8BA4\uFF0C\u8BF7\u56DE\u5230 Harness\u3002");
      } else if (wasPending && !task.approvals.size && item.mood === "waiting") {
        this.present(item, task.active ? task.tools.size ? "working" : "thinking" : "idle", task.active ? task.tools.size ? toolLabel(task.tools.values().next().value) : "\u7B49\u5F85\u4EFB\u52A1\u7EE7\u7EED\u2026" : ready);
      }
    }
  }
  select(id) {
    if (!this.sessions.has(id)) return false;
    this.selected = id;
    return true;
  }
  /** Acknowledging an older result cannot clear a newer completion. */
  read(id) {
    const result = this.results.get(id);
    if (!result || result.read) return false;
    result.read = true;
    const item = this.sessions.get(result.sessionId);
    if (item) item.unread = Math.max(0, item.unread - 1);
    return true;
  }
  remove(id) {
    this.sessions.delete(id);
    this.tasks.delete(id);
    for (const [key, result] of this.results) if (result.sessionId === id) this.results.delete(key);
    if (this.selected === id) this.selected = this.sessions.keys().next().value ?? null;
  }
  snapshot() {
    const item = this.selected ? this.sessions.get(this.selected) : void 0;
    this.settle();
    return { mood: item?.mood ?? "idle", text: item?.text ?? ready, sessionId: item?.id ?? null, revision: item?.revision ?? 0, active: item?.active ?? false, streaming: item?.streaming ?? false, speechId: item?.speechId ?? "", results: [...this.results.values()].map((r) => ({ ...r })), sessions: [...this.sessions.values()].map((s) => ({ ...s })) };
  }
};
function toolLabel(name) {
  if (/read|cat|view/.test(name)) return "\u6B63\u5728\u770B\u6587\u4EF6";
  if (/search|grep|find/.test(name)) return "\u6B63\u5728\u67E5\u627E";
  if (/write|edit|patch/.test(name)) return "\u6B63\u5728\u5199\u4EE3\u7801";
  if (/bash|shell|exec|terminal/.test(name)) return "\u6B63\u5728\u8FD0\u884C\u547D\u4EE4";
  if (/web|browse|fetch/.test(name)) return "\u6B63\u5728\u6D4F\u89C8";
  return `\u6B63\u5728\u4F7F\u7528 ${name.slice(0, 60)}`;
}
export {
  PetModel
};
//# sourceMappingURL=model.js.map
