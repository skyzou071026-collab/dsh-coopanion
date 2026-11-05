import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'coopanion-notification-n0';
export const inject = ['sessions', 'connection', 'sessionController'];
export function apply(ctx) {
  const dir = join(process.env.DSH_HOME, 'notification-n0'); mkdirSync(dir, { recursive: true });
  const record = value => appendFileSync(join(dir, 'receipts.jsonl'), JSON.stringify({ time: Date.now(), ...value }) + '\n');
  let sessionPromise;
  const getSession = () => sessionPromise ??= ctx.sessionController.create({ sessionId: `notification-n0-${Date.now()}`, cwd: dir }).then(value => {
    const session = ctx.sessions.get(value.sessionId);
    if (!session) throw new Error('Probe session is unavailable');
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    record({ type: 'probe-mounted', sessionId: session.id, creation: 'sessionController.create' });
    return session;
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/coopanion-notification-n0/probe', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const envelope = await request.json();
      if (envelope.type !== 'client-request' || envelope.method !== 'coopanion-notification-n0/probe') return Response.json({ error: 'Invalid probe request' }, { status: 400 });
      const payload = envelope.payload;
      if (payload?.action === 'record') record({ type: 'client-evidence', value: payload.value });
      const session = await getSession();
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId: session.id } } });
    },
  }));
}
