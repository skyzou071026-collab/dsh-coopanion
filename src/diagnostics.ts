import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface DiagnosticsOptions {
  registry: string; profile: string; version: string; build: unknown;
  read: () => Promise<unknown>;
}
interface Endpoint { schema: 1; instance: string; session: string; pid: number; startedAt: string; version: string; socketPath: string; token: string; }

/** Optional local pull interface. No sampler, history, business mutations or network port. */
export class Diagnostics {
  private server?: Server;
  private endpoint?: Endpoint;
  private desired = false;
  private epoch = 0;
  private changes: Promise<unknown> = Promise.resolve();
  private busy = false;
  private readonly instance: string;
  private readonly startedAt = new Date().toISOString();
  constructor(private readonly options: DiagnosticsOptions) {
    this.instance = createHash('sha256').update(options.profile).digest('hex').slice(0, 20);
  }
  configure(enabled: boolean): Promise<void> {
    if (enabled === this.desired) return this.changes.then(() => {});
    this.desired = enabled;
    const epoch = ++this.epoch;
    const run = this.changes.then(async () => {
      await this.stop();
      if (!enabled || epoch !== this.epoch) return;
      await mkdir(this.options.registry, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(this.options.registry, 0o700);
      const session = randomBytes(16).toString('hex');
      const socketPath = process.platform === 'win32'
        ? '\\\\.\\pipe\\dsh-coopanion-' + session
        : join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dsh-coopanion-' + session + '.sock');
      const endpoint: Endpoint = { schema: 1, instance: this.instance, session, pid: process.pid, startedAt: this.startedAt, version: this.options.version, socketPath, token: randomBytes(32).toString('hex') };
      const server = createServer(async (req, res) => {
        const reply = (code: number, body: unknown) => {
          if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
        };
        if (req.headers.origin || req.headers.authorization !== 'Bearer ' + endpoint.token) { reply(403, { error: 'denied' }); return; }
        if (req.method !== 'GET' || req.url !== '/snapshot') { reply(405, { error: 'read-only' }); return; }
        if (!this.desired || epoch !== this.epoch) { reply(503, { error: 'disabled' }); return; }
        if (this.busy) { reply(429, { error: 'busy' }); return; }
        this.busy = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([this.options.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2000); })]);
          if (!this.desired || epoch !== this.epoch) { reply(503, { error: 'disabled' }); return; }
          const body = { schema: 1, instance: endpoint.instance, session: endpoint.session, pid: process.pid, startedAt: endpoint.startedAt, measuredAt: new Date().toISOString(), version: endpoint.version, build: this.options.build, value };
          const serialized = JSON.stringify(body);
          if (Buffer.byteLength(serialized) > 32768) throw new Error('oversized');
          reply(200, body);
        } catch { reply(503, { error: 'unavailable' }); }
        finally { if (timer) clearTimeout(timer); this.busy = false; }
      });
      server.requestTimeout = 3000; server.headersTimeout = 3000; server.keepAliveTimeout = 1000; server.maxConnections = 4;
      this.server = server; this.endpoint = endpoint;
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
        // Keep asynchronous socket errors contained after successful listen.
        server.on('error', () => {});
        if (process.platform !== 'win32') await chmod(socketPath, 0o600);
        const file = join(this.options.registry, this.instance + '-' + process.pid + '.json');
        const temporary = file + '.' + session + '.tmp';
        await writeFile(temporary, JSON.stringify(endpoint) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch (error) { await this.stop(); this.desired = false; throw error; }
      if (epoch !== this.epoch) await this.stop();
    });
    this.changes = run.catch(() => {});
    return run;
  }
  private async stop(): Promise<void> {
    const server = this.server, endpoint = this.endpoint;
    this.server = undefined; this.endpoint = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (endpoint) {
      await rm(join(this.options.registry, endpoint.instance + '-' + process.pid + '.json'), { force: true });
      if (process.platform !== 'win32') await rm(endpoint.socketPath, { force: true });
    }
  }
  async close(): Promise<void> { await this.configure(false); }
  /** Exit cleanup only removes files carrying this process's unique session. */
  release(): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    const file = join(this.options.registry, endpoint.instance + '-' + process.pid + '.json');
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).session === endpoint.session) rmSync(file, { force: true });
    } catch { /* Absent or foreign descriptor. */ }
    if (process.platform !== 'win32') { try { rmSync(endpoint.socketPath, { force: true }); } catch { /* Exit cleanup. */ } }
  }
}
