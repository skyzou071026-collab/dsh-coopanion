export interface ChatRequest { type: 'chat'; sessionId: string; requestId: string; text: string; clientTimeZone: string; }
export type ChatReceipt = { type: 'chat-result'; sessionId: string; requestId: string } & ({ status: 'accepted' } | { status: 'failed'; code: string });
export function chatRequest(value: unknown): ChatRequest | undefined;
export function chatReceipt(value: unknown): value is ChatReceipt;
