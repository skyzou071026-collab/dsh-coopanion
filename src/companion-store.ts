import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const identity = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative().max(1_000_000_000);
const relation = z.object({ total: count, days: z.array(day).max(3), date: day, count: count.max(3), lastAt: z.number().nonnegative(), unlocked: z.boolean() }).strict();
const archive = z.object({ schema: z.literal(1), revision: count, date: day, lastAt: z.number().nonnegative(), invitations: count.max(2), quiet: z.boolean(), laterUntil: z.number().nonnegative(), characters: z.record(id, relation), recent: z.array(identity).max(128) }).strict();
export const companionRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), characterId: id }).strict(),
  ...(['invite', 'pet', 'play', 'later', 'quiet', 'resume', 'remove'] as const).map(type => z.object({ type: z.literal(type), characterId: id, requestId: identity, revision: count }).strict()),
]);
export type CompanionRequest = z.infer<typeof companionRequest>;
type Archive = z.infer<typeof archive>;
export interface CompanionSummary {
  revision: number; writable: boolean; error?: string;
  relation: { total: number; days: number; unlocked: boolean };
  invitation: { remaining: number; quiet: boolean; laterUntil: number };
}
export interface CompanionReceipt extends CompanionSummary { applied: boolean; }
const localDate = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fresh = (date: string): Archive => ({ schema: 1, revision: 0, date, lastAt: 0, invitations: 0, quiet: false, laterUntil: 0, characters: {}, recent: [] });
const emptyRelation = (date: string): z.infer<typeof relation> => ({ total: 0, days: [], date, count: 0, lastAt: 0, unlocked: false });

/** One profile's bounded, versioned relationship state. Dates and budgets belong to this owner. */
export class CompanionStore {
  private data?: Archive;
  private pending = 0;
  private bytes = 0;
  private writable = false;
  private error?: string;
  private initialized?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly token = randomUUID();
  private closed = false;
  private readonly file: string;
  private readonly lock: string;
  constructor(readonly directory: string, private readonly clock = Date.now) {
    this.file = join(directory, 'state.json'); this.lock = join(directory, 'writer.lock');
  }
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try { await this.acquire(); }
    catch { this.error = 'companion/readonly'; }
    try {
      const raw = await readFile(this.file, 'utf8');
      this.bytes = Buffer.byteLength(raw);
      if (raw.length > 256 * 1024) throw new Error('oversized');
      this.data = archive.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.data = fresh(localDate(this.clock()));
      else { this.error = 'companion/invalid-save'; this.release(); }
    }
  }
  private async acquire(): Promise<void> {
    try { await mkdir(this.lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(join(this.lock, 'owner.json'), 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('unknown lock');
      try { process.kill(owner.pid, 0); throw new Error('writer active'); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
      const claim = join(this.lock, 'reclaim');
      await mkdir(claim);
      try {
        const current = JSON.parse(await readFile(join(this.lock, 'owner.json'), 'utf8'));
        if (current.token !== owner.token || current.pid !== owner.pid) throw new Error('lock changed');
        const retired = `${this.lock}.${this.token}.stale`;
        await rename(this.lock, retired); await rm(retired, { recursive: true });
      } catch (failure) { await rm(claim, { recursive: true, force: true }); throw failure; }
      await mkdir(this.lock);
    }
    try { await writeFile(join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: this.token }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(this.lock, { recursive: true, force: true }); throw error; }
    this.writable = true;
  }
  /** Synchronous exit hook: only our own token may release the lock. */
  release(): void {
    try { if (JSON.parse(readFileSync(join(this.lock, 'owner.json'), 'utf8')).token === this.token) rmSync(this.lock, { recursive: true, force: true }); } catch { /* An absent/foreign lock is not ours. */ }
    this.writable = false;
  }
  async close(): Promise<void> { this.closed = true; await this.queue.catch(() => {}); this.release(); }
  private current(): Archive {
    const next = structuredClone(this.data ?? fresh(localDate(this.clock())));
    const date = localDate(this.clock());
    if (date > next.date) { next.date = date; next.invitations = 0; next.quiet = false; }
    return next;
  }
  private summary(data = this.current(), characterId: string): CompanionSummary {
    const r = Object.hasOwn(data.characters, characterId) ? data.characters[characterId]! : emptyRelation(data.date);
    return { revision: data.revision, writable: this.writable && !this.closed && !this.error, ...(this.error ? { error: this.error } : {}), relation: { total: r.total, days: r.days.length, unlocked: r.unlocked }, invitation: { remaining: 2 - data.invitations, quiet: data.quiet, laterUntil: data.laterUntil } };
  }
  /** Read-only in-memory diagnostics: never initializes, writes or joins the request queue. */
  inspect() { return { initialized: !!this.data, writable: this.writable && !this.closed && !this.error, failed: !!this.error,
    bytes: this.bytes, revision: this.data?.revision ?? 0, recentCount: this.data?.recent.length ?? 0,
    characterCount: Object.keys(this.data?.characters ?? {}).length, invitations: this.data?.invitations ?? 0, pending: this.pending }; }
  request(input: unknown): Promise<CompanionReceipt> {
    const request = companionRequest.parse(input);
    this.pending++;
    const run = this.queue.then(async () => {
      await (this.initialized ??= this.initialize());
      if (!this.writable && !this.error?.includes('invalid-save')) {
        try { this.data = archive.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = 'companion/invalid-save'; }
      }
      const next = this.current();
      if (request.type === 'read') return { ...this.summary(next, request.characterId), applied: false };
      if (!this.writable || this.closed || this.error) throw new Error(this.error ?? 'companion/readonly');
      if (next.recent.includes(request.requestId)) return { ...this.summary(next, request.characterId), applied: false };
      if (request.revision !== next.revision) throw new Error('companion/revision-conflict');
      const now = Math.max(this.clock(), next.lastAt);
      let applied = true;
      if (request.type === 'invite') {
        const hour = new Date(this.clock()).getHours();
        if (hour < 7 || hour >= 22 || next.invitations >= 2 || next.quiet || now < next.laterUntil) applied = false;
        else next.invitations++;
      } else if (request.type === 'quiet') next.quiet = true;
      else if (request.type === 'resume') { next.quiet = false; next.laterUntil = 0; }
      else if (request.type === 'later') next.laterUntil = now + 3600000;
      else if (request.type === 'remove') delete next.characters[request.characterId];
      else {
        const r = Object.hasOwn(next.characters, request.characterId) ? next.characters[request.characterId]! : emptyRelation(next.date);
        if (r.date < next.date) { r.date = next.date; r.count = 0; }
        if (r.count >= 3 || r.total > 0 && now - r.lastAt < 300000) applied = false;
        else {
          r.total++; r.count++; r.lastAt = now;
          if (!r.days.includes(next.date)) r.days = [...r.days, next.date].slice(-3);
          r.unlocked ||= r.total >= 6 && r.days.length >= 3;
          next.characters[request.characterId] = r;
        }
      }
      next.lastAt = now; next.revision++; next.recent = [...next.recent, request.requestId].slice(-128);
      if (Object.keys(next.characters).length > 256) throw new Error('companion/character-limit');
      const temp = `${this.file}.${this.token}.tmp`;
      const serialized = JSON.stringify(next) + '\n';
      try { await writeFile(temp, serialized, { mode: 0o600 }); await rename(temp, this.file); this.bytes = Buffer.byteLength(serialized); }
      finally { await rm(temp, { force: true }); }
      this.data = next;
      return { ...this.summary(next, request.characterId), applied };
    });
    run.then(() => { this.pending--; }, () => { this.pending--; });
    this.queue = run.catch(() => {});
    return run;
  }
}
