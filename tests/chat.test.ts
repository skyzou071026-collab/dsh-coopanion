import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ChatSubmission } from '../src/chat.ts';
import { chatRequest } from '../web/chat-contract.js';
const request = { type: 'chat' as const, sessionId: 'cold', requestId: 'client-full-request-0001', text: 'exact\nmessage 🐳', clientTimeZone: 'Asia/Shanghai' };
async function harness() {
  const ctx = new Context(); const session = Session.create(SessionId('cold'), [], { id: SessionId('cold'), version: 4, createdAt: 0, isSeeded: false, cwd: '/project' });
  const prompt = vi.fn(async (input: unknown) => {
    await new Promise(r => setTimeout(r, 2));
    const value = input as { requestId: string; content: { type: 'text'; text: string }[]; clientTimeZone: string };
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [createUserMessage({ content: value.content, source: { kind: 'user', rpcId: value.requestId as never, clientTimeZone: value.clientTimeZone } })] });
    return { accepted: true as const };
  });
  const observe = vi.fn(async () => ({ header: session.header, events: session.snapshotEvents(), [Symbol.dispose]: vi.fn() }));
  ctx.provide('sessionQuery', { observeSession: observe });
  const catalog = vi.fn(async () => ({ default: { provider: 'test', model: 'test' }, groups: [{ id: 'test', models: [{ id: 'test' }] }] }));
  ctx.provide('sessionController', { prompt, modelCatalog: catalog });
  return { ctx, session, prompt, observe, catalog, chat: new ChatSubmission(ctx), send: (chat: ChatSubmission, input = request, signal = new AbortController().signal) => chat.submit(input, signal) };
}
it('deduplicates concurrent and claimed retries, verifies payload, and admits new identities in order', async () => {
  const h = await harness();
  try {
    const both = await Promise.all([h.send(h.chat), h.send(h.chat)]);
    expect(both.every(value => value?.status === 'accepted')).toBe(true); expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(await h.send(new ChatSubmission(h.ctx))).toMatchObject({ status: 'accepted' }); // new Host admission cache; persistent inserted record
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(await h.send(new ChatSubmission(h.ctx), { ...request, text: 'changed' })).toMatchObject({ status: 'failed', code: 'coopanion/request-conflict' });
    expect(await h.send(h.chat, { ...request, sessionId: 'other' })).toMatchObject({ status: 'failed', code: 'coopanion/request-conflict' });
    await h.send(h.chat, { ...request, requestId: 'next-new-full' }); expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.prompt.mock.calls[0][0]).toMatchObject({ sessionId: 'cold', requestId: request.requestId, mode: 'queue', content: [{ type: 'text', text: request.text }], clientTimeZone: request.clientTimeZone });
  } finally { await h.ctx.fiber.dispose(); }
});
it.each(['session/writer-held', 'session/model-unavailable', 'gateway/forbidden', 'session/not-found'])('preserves controller error %s and permits same-ID retry', async code => {
  const h = await harness(); try {
    h.prompt.mockRejectedValueOnce(Object.assign(new Error('failure'), { code }));
    expect(await h.send(h.chat)).toMatchObject({ status: 'failed', code });
    expect(await h.send(h.chat)).toMatchObject({ status: 'accepted', requestId: request.requestId });
  } finally { await h.ctx.fiber.dispose(); }
});
it('rejects absent service, cancelled work, subagents, mismatched target and unavailable model before queue admission', async () => {
  const h = await harness(); try {
    const cancel = new AbortController(); cancel.abort();
    expect(await h.send(h.chat, request, cancel.signal)).toMatchObject({ status: 'failed', code: 'gateway/cancelled' });
    h.observe.mockResolvedValueOnce({ header: { ...h.session.header, origin: 'subagent' }, events: [], [Symbol.dispose]: vi.fn() } as never);
    expect(await h.send(h.chat)).toMatchObject({ code: 'session/subagent-owned' });
    h.observe.mockResolvedValueOnce({ header: { ...h.session.header, id: 'other' }, events: [], [Symbol.dispose]: vi.fn() } as never);
    expect(await h.send(h.chat)).toMatchObject({ code: 'session/not-found' });
    h.catalog.mockResolvedValueOnce({ default: { provider: 'none', model: 'none' }, groups: [] });
    expect(await h.send(h.chat)).toMatchObject({ code: 'session/model-unavailable' });
    h.observe.mockRejectedValueOnce(Object.assign(new Error('read failed', { cause: Object.assign(new Error('denied'), { code: 'EACCES' }) }), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }));
    expect(await h.send(h.chat)).toMatchObject({ code: 'gateway/forbidden' });
    expect(h.prompt).not.toHaveBeenCalled();
  } finally { await h.ctx.fiber.dispose(); }
  const empty = new Context(); try { expect(await new ChatSubmission(empty).submit(request, new AbortController().signal)).toMatchObject({ code: 'coopanion/service-unavailable' }); } finally { await empty.fiber.dispose(); }
});
it('validates wire content and never accepts missing complete request identity', () => {
  expect(chatRequest(request)).toEqual(request);
  for (const value of [{ ...request, requestId: undefined }, { ...request, text: ' ' }, { ...request, text: 'x'.repeat(2001) }, { ...request, clientTimeZone: 'bad' }, { ...request, mode: 'steer' }]) expect(chatRequest(value)).toBeUndefined();
});
