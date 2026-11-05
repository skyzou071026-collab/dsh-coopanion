import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionStore } from '../src/companion-store.ts';
async function fixture(run: (f: { store: CompanionStore; directory: string; set: (n: number) => void; get: () => number; read: (id?: string) => ReturnType<CompanionStore['request']>; act: (type: string, id?: string, requestId?: string) => ReturnType<CompanionStore['request']> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-store-')); let now = new Date(2026, 9, 15, 12).getTime(), seq = 0;
  const store = new CompanionStore(directory, () => now);
  const read = (id = 'whale') => store.request({ type: 'read', characterId: id });
  const act = async (type: string, id = 'whale', requestId = `care-${++seq}`) => store.request({ type, characterId: id, requestId, revision: (await read(id)).revision });
  try { await run({ store, directory, set: n => { now = n; }, get: () => now, read, act }); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}
describe('persistent companion relationships and profile budgets', () => {
  it('deduplicates, cools down, caps each day, and unlocks across three dates', async () => fixture(async f => {
    for (let day = 0; day < 3; day++) {
      f.set(new Date(2026, 9, 15 + day, 12).getTime());
      expect((await f.act('pet', 'whale', `day-${day}`)).applied).toBe(true);
      expect((await f.act('pet', 'whale', `day-${day}`)).applied).toBe(false);
      expect((await f.act('play')).applied).toBe(false);
      f.set(f.get() + 300000); await f.act('play');
    }
    expect((await f.read()).relation).toEqual({ total: 6, days: 3, unlocked: true });
    f.set(f.get() + 300000); await f.act('pet'); f.set(f.get() + 300000); expect((await f.act('pet')).applied).toBe(false);
    expect((await f.read('paper-star')).relation.total).toBe(0);
    const before = (await f.read()).relation;
    f.set(f.get() + 7 * 86400000); expect((await f.read()).relation).toEqual(before);
  }));
  it('shares invitation budget and quiet across characters and restart, and resists date rollback', async () => fixture(async f => {
    await f.act('invite'); await f.act('invite', 'paper-star'); expect((await f.act('invite')).applied).toBe(false);
    await f.act('quiet'); expect((await f.read('paper-star')).invitation.quiet).toBe(true);
    await f.store.close(); const reopened = new CompanionStore(f.directory, () => f.get());
    try {
      const r = await reopened.request({ type: 'read', characterId: 'whale' }); expect(r.invitation).toMatchObject({ remaining: 0, quiet: true });
      f.set(f.get() - 86400000); expect((await reopened.request({ type: 'read', characterId: 'whale' })).invitation.remaining).toBe(0);
      f.set(f.get() + 2 * 86400000); expect((await reopened.request({ type: 'read', characterId: 'whale' })).invitation).toMatchObject({ remaining: 2, quiet: false });
    } finally { await reopened.close(); }
  }));
  it('does not invite at night or during snooze, allows quiet resume, rejects stale revisions', async () => fixture(async f => {
    await f.act('later'); expect((await f.act('invite')).applied).toBe(false);
    await f.act('quiet'); await f.act('resume'); expect((await f.act('invite')).applied).toBe(true);
    await expect(f.store.request({ type: 'pet', characterId: 'whale', revision: 0, requestId: 'stale' })).rejects.toThrow('revision-conflict');
    f.set(new Date(2026, 9, 16, 23).getTime()); expect((await f.act('invite')).applied).toBe(false);
  }));
  it('keeps a single writer, reloads after close, handles prototype-named ids, and removes one relation', async () => fixture(async f => {
    await f.act('pet', 'constructor'); expect((await f.read('constructor')).relation.total).toBe(1);
    const other = new CompanionStore(f.directory); try { expect((await other.request({ type: 'read', characterId: 'whale' })).writable).toBe(false); await expect(other.request({ type: 'quiet', characterId: 'whale', requestId: 'locked', revision: 1 })).rejects.toThrow('readonly'); } finally { await other.close(); }
    await f.act('remove', 'constructor'); expect((await f.read('constructor')).relation.total).toBe(0);
  }));
  it.each(['{bad json', '{"schema":999}'])('preserves invalid/future archives byte-for-byte (%s)', async raw => fixture(async f => {
    await writeFile(join(f.directory, 'state.json'), raw);
    expect(await f.read()).toMatchObject({ writable: false, error: 'companion/invalid-save' });
    await expect(f.act('pet')).rejects.toThrow('invalid-save'); expect(await readFile(join(f.directory, 'state.json'), 'utf8')).toBe(raw);
  }));
  it('bounds the ledger, validates wire input, and recovers a dead writer', async () => fixture(async f => {
    await mkdir(join(f.directory, 'writer.lock')); await writeFile(join(f.directory, 'writer.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'old' }));
    expect((await f.read()).writable).toBe(true);
    for (let i = 0; i < 140; i++) await f.act('pet');
    const raw = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')); expect(raw.recent).toHaveLength(128);
    expect(() => f.store.request({ type: 'pet', characterId: '../escape', requestId: 'x', revision: 0 })).toThrow();
    expect(() => f.store.request({ type: 'invite', characterId: 'whale', requestId: 'x', revision: 0, date: '2099-01-01' })).toThrow();
  }));
});

it('failed atomic replacement cannot report saved growth, and concurrent stale writes cannot overwrite', async () => fixture(async f => {
  const initial = await f.read();
  await mkdir(join(f.directory, 'state.json'));
  await expect(f.store.request({ type: 'pet', characterId: 'whale', requestId: 'write-fails', revision: initial.revision })).rejects.toThrow();
  expect((await f.read()).relation.total).toBe(0);
  await rm(join(f.directory, 'state.json'), { recursive: true });
  const results = await Promise.allSettled([
    f.store.request({ type: 'pet', characterId: 'whale', requestId: 'first', revision: initial.revision }),
    f.store.request({ type: 'play', characterId: 'whale', requestId: 'late', revision: initial.revision }),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  expect((await f.read()).relation.total).toBe(1);
}));
