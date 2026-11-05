import { describe, it, expect } from 'vitest';
import { CompanionClient } from '../web/companion-client.js';
const summary = revision => ({ revision, writable: true, relation: { total: revision, days: 1, unlocked: false }, invitation: { remaining: 2, quiet: false, laterUntil: 0 } });
describe('trusted companionship request adapter', () => {
  it('serializes mutation revisions and preserves immutable interaction ids', async () => {
    const requests = []; let revision = 0;
    const client = new CompanionClient(async r => { requests.push(r); if (r.type !== 'read') { expect(r.revision).toBe(revision); revision++; } return summary(revision); });
    await client.load('whale'); await Promise.all([client.request('pet', 'first'), client.request('play', 'second')]);
    expect(requests.map(r => r.requestId).filter(Boolean)).toEqual(['first', 'second']); expect(client.summary.revision).toBe(2);
  });
  it('drops replies from a previous character and does not reassign old care', async () => {
    let resolve; const requests = [];
    const client = new CompanionClient(r => { requests.push(r); return r.characterId === 'whale' ? new Promise(done => { resolve = done; }) : Promise.resolve(summary(0)); });
    const old = client.load('whale'); await Promise.resolve(); const next = client.load('paper-star'); resolve(summary(99)); await old; await next;
    expect(client.characterId).toBe('paper-star'); expect(client.summary.revision).toBe(0); expect(requests).toHaveLength(2);
  });
  it('refreshes a conflict but never replays a mutation or reports a failed write as growth', async () => {
    const calls = []; const client = new CompanionClient(async r => { calls.push(r.type); if (r.type === 'play') throw new Error('companion/revision-conflict'); return summary(0); });
    await client.load('whale'); expect(await client.request('play', 'once')).toBe(null);
    expect(calls).toEqual(['read', 'play', 'read']); expect(client.summary.relation.total).toBe(0); expect(client.error).toContain('conflict');
  });
});
