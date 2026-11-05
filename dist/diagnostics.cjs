"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/diagnostics.ts
var diagnostics_exports = {};
__export(diagnostics_exports, {
  Diagnostics: () => Diagnostics
});
module.exports = __toCommonJS(diagnostics_exports);
var import_node_http = require("node:http");
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var Diagnostics = class {
  constructor(options) {
    this.options = options;
    this.instance = (0, import_node_crypto.createHash)("sha256").update(options.profile).digest("hex").slice(0, 20);
  }
  server;
  endpoint;
  desired = false;
  epoch = 0;
  changes = Promise.resolve();
  busy = false;
  instance;
  startedAt = (/* @__PURE__ */ new Date()).toISOString();
  configure(enabled) {
    if (enabled === this.desired) return this.changes.then(() => {
    });
    this.desired = enabled;
    const epoch = ++this.epoch;
    const run = this.changes.then(async () => {
      await this.stop();
      if (!enabled || epoch !== this.epoch) return;
      await (0, import_promises.mkdir)(this.options.registry, { recursive: true, mode: 448 });
      if (process.platform !== "win32") await (0, import_promises.chmod)(this.options.registry, 448);
      const session = (0, import_node_crypto.randomBytes)(16).toString("hex");
      const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\dsh-coopanion-" + session : (0, import_node_path.join)(process.platform === "darwin" ? "/tmp" : (0, import_node_os.tmpdir)(), "dsh-coopanion-" + session + ".sock");
      const endpoint = { schema: 1, instance: this.instance, session, pid: process.pid, startedAt: this.startedAt, version: this.options.version, socketPath, token: (0, import_node_crypto.randomBytes)(32).toString("hex") };
      const server = (0, import_node_http.createServer)(async (req, res) => {
        const reply = (code, body) => {
          if (!res.destroyed) {
            res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(body));
          }
        };
        if (req.headers.origin || req.headers.authorization !== "Bearer " + endpoint.token) {
          reply(403, { error: "denied" });
          return;
        }
        if (req.method !== "GET" || req.url !== "/snapshot") {
          reply(405, { error: "read-only" });
          return;
        }
        if (!this.desired || epoch !== this.epoch) {
          reply(503, { error: "disabled" });
          return;
        }
        if (this.busy) {
          reply(429, { error: "busy" });
          return;
        }
        this.busy = true;
        let timer;
        try {
          const value = await Promise.race([this.options.read(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 2e3);
          })]);
          if (!this.desired || epoch !== this.epoch) {
            reply(503, { error: "disabled" });
            return;
          }
          const body = { schema: 1, instance: endpoint.instance, session: endpoint.session, pid: process.pid, startedAt: endpoint.startedAt, measuredAt: (/* @__PURE__ */ new Date()).toISOString(), version: endpoint.version, build: this.options.build, value };
          const serialized = JSON.stringify(body);
          if (Buffer.byteLength(serialized) > 32768) throw new Error("oversized");
          reply(200, body);
        } catch {
          reply(503, { error: "unavailable" });
        } finally {
          if (timer) clearTimeout(timer);
          this.busy = false;
        }
      });
      server.requestTimeout = 3e3;
      server.headersTimeout = 3e3;
      server.keepAliveTimeout = 1e3;
      server.maxConnections = 4;
      this.server = server;
      this.endpoint = endpoint;
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", () => {
        });
        if (process.platform !== "win32") await (0, import_promises.chmod)(socketPath, 384);
        const file = (0, import_node_path.join)(this.options.registry, this.instance + "-" + process.pid + ".json");
        const temporary = file + "." + session + ".tmp";
        await (0, import_promises.writeFile)(temporary, JSON.stringify(endpoint) + "\n", { mode: 384, flag: "wx" });
        await (0, import_promises.rename)(temporary, file);
      } catch (error) {
        await this.stop();
        this.desired = false;
        throw error;
      }
      if (epoch !== this.epoch) await this.stop();
    });
    this.changes = run.catch(() => {
    });
    return run;
  }
  async stop() {
    const server = this.server, endpoint = this.endpoint;
    this.server = void 0;
    this.endpoint = void 0;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (endpoint) {
      await (0, import_promises.rm)((0, import_node_path.join)(this.options.registry, endpoint.instance + "-" + process.pid + ".json"), { force: true });
      if (process.platform !== "win32") await (0, import_promises.rm)(endpoint.socketPath, { force: true });
    }
  }
  async close() {
    await this.configure(false);
  }
  /** Exit cleanup only removes files carrying this process's unique session. */
  release() {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    const file = (0, import_node_path.join)(this.options.registry, endpoint.instance + "-" + process.pid + ".json");
    try {
      if (JSON.parse((0, import_node_fs.readFileSync)(file, "utf8")).session === endpoint.session) (0, import_node_fs.rmSync)(file, { force: true });
    } catch {
    }
    if (process.platform !== "win32") {
      try {
        (0, import_node_fs.rmSync)(endpoint.socketPath, { force: true });
      } catch {
      }
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Diagnostics
});
