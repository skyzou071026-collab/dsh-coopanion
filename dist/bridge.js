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
        child.off("message", ready);
        child.off("error", failed);
        child.off("exit", exited);
        lifetime?.signal.removeEventListener("abort", aborted);
        if (error) {
          child.kill();
          reject(error);
        } else resolve();
      };
      const ready = (message) => {
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
      child.on("message", ready);
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
  snoozeResult(interactionId, ok, error) {
    this.send({ type: "notification-snooze-result", interactionId, ok, ...error ? { error: error.slice(0, 600) } : {} });
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
export {
  ElectronBridge,
  NativeStartError,
  isRecord
};
//# sourceMappingURL=bridge.js.map
