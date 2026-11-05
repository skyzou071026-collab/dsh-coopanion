import { petLanguage } from '../../web/locale.js';

/** The resolved Harness locale follows plugin lifetime, independently of workspace and notifications. */
export function syncPetLocale({ current, subscribe, send, retryMs = 750, timeoutMs = 5000 }: {
  current: () => string;
  subscribe: (listener: (force?: boolean) => void) => () => void;
  send: (locale: string, signal: AbortSignal) => Promise<void>;
  retryMs?: number; timeoutMs?: number;
}): () => void {
  let stopped = false, accepted: string | undefined, pending: string | undefined;
  let controller: AbortController | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  const sync = (force = false) => {
    if (stopped) return;
    const locale = petLanguage(current());
    if (!force && (locale === pending || locale === accepted && !pending)) return;
    clearTimeout(retry); controller?.abort();
    const request = new AbortController(); controller = request; pending = locale;
    const deadline = setTimeout(() => request.abort(), timeoutMs);
    const aborted = new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('Locale request cancelled')), { once: true }));
    void Promise.race([Promise.resolve().then(() => {
      if (request.signal.aborted) throw new Error('Locale request cancelled');
      return send(locale, request.signal);
    }), aborted]).then(() => {
      if (controller === request && !request.signal.aborted) accepted = locale;
    }).catch(() => {
      if (controller === request && !stopped) retry = setTimeout(sync, retryMs);
    }).finally(() => {
      clearTimeout(deadline);
      if (controller === request) { pending = undefined; controller = undefined; }
    });
  };
  const unsubscribe = subscribe(sync); sync();
  return () => { stopped = true; unsubscribe(); clearTimeout(retry); controller?.abort(); };
}
