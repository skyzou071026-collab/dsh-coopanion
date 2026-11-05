/** Shared desktop/Host wire contract. Acceptance means queue admission, never task completion. */
export function chatRequest(value) {
  if (!value || value.type !== 'chat' || Object.keys(value).some(k => !['type', 'sessionId', 'requestId', 'text', 'clientTimeZone'].includes(k))) return;
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512 || typeof value.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.requestId)) return;
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000 || typeof value.clientTimeZone !== 'string' || value.clientTimeZone.length > 100) return;
  try {
    const clientTimeZone = new Intl.DateTimeFormat('en', { timeZone: value.clientTimeZone }).resolvedOptions().timeZone;
    return { type: 'chat', sessionId: value.sessionId, requestId: value.requestId, text: value.text.trim(), clientTimeZone };
  } catch { return; }
}
export function chatReceipt(value) {
  return value?.type === 'chat-result' && typeof value.sessionId === 'string' && typeof value.requestId === 'string' &&
    (value.status === 'accepted' || value.status === 'failed' && typeof value.code === 'string');
}
