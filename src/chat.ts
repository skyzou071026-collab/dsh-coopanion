import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller';
import { chatRequest, type ChatRequest, type ChatReceipt } from '../web/chat-contract.js';

/** Serialize admission per target: the supported controllers deduplicate history, but race across async admission. */
export class ChatSubmission {
  private tails = new Map<string, Promise<unknown>>();
  private requests = new Map<string, string>();
  constructor(private readonly ctx: Context) {}
  async submit(value: unknown, signal: AbortSignal): Promise<ChatReceipt | undefined> {
    const input = chatRequest(value);
    if (!input) return;
    const identity = JSON.stringify(input);
    const result = (status: 'accepted' | 'failed', code?: string): ChatReceipt => status === 'accepted'
      ? { type: 'chat-result', sessionId: input.sessionId, requestId: input.requestId, status }
      : { type: 'chat-result', sessionId: input.sessionId, requestId: input.requestId, status, code: code! };
    if (this.requests.has(input.requestId) && this.requests.get(input.requestId) !== identity) return result('failed', 'coopanion/request-conflict');
    this.requests.set(input.requestId, identity);
    if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value!);
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      try { await this.admit(input, signal); return result('accepted'); }
      catch (error) {
        const code = signal.aborted ? 'gateway/cancelled' : chatErrorCode(error);
        return result('failed', code);
      }
    });
    this.tails.set(input.sessionId, task);
    try { return await task; } finally { if (this.tails.get(input.sessionId) === task) this.tails.delete(input.sessionId); }
  }
  private async admit(input: ChatRequest, signal: AbortSignal): Promise<void> {
    const reject = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    signal.throwIfAborted();
    const controller = this.ctx.get('sessionController'), query = this.ctx.get('sessionQuery');
    if (!controller || !query) reject('coopanion/service-unavailable');
    // Re-read the exact target and persisted identity, including requests still in the inbox.
    const observed = await query!.observeSession(SessionId(input.sessionId), { signal });
    try {
      if (observed.header.id !== input.sessionId || !observed.header.cwd) reject('session/not-found');
      if (observed.header.origin === 'subagent') reject('session/subagent-owned');
      const messages = observed.events.flatMap(event => event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []);
      const matches = messages.filter(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === input.requestId);
      if (matches.length) {
        if (matches.some(message => JSON.stringify(message.content) !== JSON.stringify([{ type: 'text', text: input.text }]) || !('clientTimeZone' in message.source) || message.source.clientTimeZone !== input.clientTimeZone)) reject('coopanion/request-conflict');
        return; // Surviving durable admissions include claimed and cancelled inbox entries.
      }
      const catalog = await controller!.modelCatalog();
      const selected = observed.projections?.values.modelSelection?.next ?? catalog.default;
      if (!catalog.groups.some(group => group.id === selected.provider && group.models.some(model => model.id === selected.model))) reject('session/model-unavailable');
    } finally { observed[Symbol.dispose](); }
    signal.throwIfAborted();
    const receipt = await controller!.prompt({ sessionId: SessionId(input.sessionId), requestId: input.requestId as SessionPromptRequest['requestId'], mode: 'queue', content: [{ type: 'text', text: input.text }], clientTimeZone: input.clientTimeZone }, signal);
    if (receipt.accepted !== true) reject('coopanion/no-receipt');
    // The controller stops observing cancellation once admission starts. Never convert an accepted prompt to cancelled.
  }
}

function chatErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === 'EACCES' || value.code === 'EPERM') return 'gateway/forbidden';
    current = value.cause;
  }
  const code = (error as { code?: unknown })?.code;
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') return 'session/not-found';
  if (code === 'SESSION_QUERY_ABORTED') return 'gateway/cancelled';
  return typeof code === 'string' ? code : 'coopanion/unavailable';
}
