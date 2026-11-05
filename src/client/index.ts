import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PetStatus } from '../controls.ts';
import { Settings, type SettingsFace, type Preferences } from './Settings.tsx';
import { en, zh, type LocaleKey } from './locales.ts';
import css from './settings.css';
import type { BrowserNotificationApi } from './system-notifications.ts';
import { NotificationClient } from './notification-client.ts';
import { notificationPreferencesSchema, type DeliveryClaim, type NotificationSnapshot } from '../notification-contract.ts';
import { syncPetLocale } from './locale-sync.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { coopanion: LocaleKey; } }
declare module '@deepseek-ai/cordis' { interface Context { connection: ConnectionHandle; } }
export const inject = ['slots', 'locale', 'configForms', 'connection'];

/** A regular DSH settings section, using Host forms and the authenticated Connection carrier. */
export function apply(ctx: Context): void {
  const currentLocale = () => ctx.locale.resolveText({ zh: 'zh', en: 'en' });
  ctx.effect(() => ctx.locale.register('coopanion', { zh, en }));
  ctx.effect(() => {
    if (!ctx.connection.isLoopback) return () => {};
    return syncPetLocale({
      current: currentLocale,
      subscribe: listener => {
        const unsubscribe = ctx.locale.subscribe(() => listener());
        const focus = () => { if (document.visibilityState !== 'hidden') listener(true); };
        window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
        return () => { unsubscribe(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
      },
      send: async (locale, signal) => {
        const response = await ctx.connection.rpc.call('/api', 'coopanion/locale', { locale }, signal);
        if (!response.ok) throw new Error(response.error.message);
      },
    });
  });
  ctx.effect(() => {
    const tag = document.createElement('style'); tag.dataset.plugin = 'dsh-coopanion'; tag.textContent = css;
    document.head.append(tag); return () => tag.remove();
  });
  const face: SettingsFace = {
    form: ctx.configForms.get<Preferences>('dsh-coopanion'),
    local: ctx.connection.isLoopback,
    call: async (command, signal) => {
      const reply = await ctx.connection.rpc.call('/api', command ? 'coopanion/control' : 'coopanion/status', command ? { command } : {}, signal);
      if (!reply.ok) throw new Error(reply.error.message);
      const value = reply.value as PetStatus;
      if (!value || !['stopped', 'starting', 'running', 'stopping', 'recovering', 'error'].includes(value.phase) || typeof value.visible !== 'boolean') throw new Error('Invalid desktop pet status');
      return value;
    },
  };
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-coopanion', order: 60,
    label: () => ctx.locale.bind('coopanion')('nav'), locale: 'coopanion', inject: () => face,
  }, Settings));
  ctx.inject(['uiWorkspace'], child => {
    if (!ctx.connection.isLoopback) return;
    child.effect(() => {
      const request = async <T,>(endpoint: string, payload: unknown, signal: AbortSignal): Promise<T> => {
        const reply = await ctx.connection.rpc.call('/api', `coopanion/${endpoint}`, payload, signal);
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.value as T;
      };
      const client = new NotificationClient({
        locale: currentLocale,
        api: globalThis.Notification as unknown as BrowserNotificationApi,
        transport: {
          state: signal => request<NotificationSnapshot>('notification-state', {}, signal),
          claim: (payload, signal) => request<DeliveryClaim | null>('notification-claim', payload, signal),
          receipt: (payload, signal) => request('notification-receipt', payload, signal),
          snooze: (payload, signal) => request('notification-snooze', payload, signal),
        },
        preferences: () => {
          const value = face.form.getSnapshot().value;
          return notificationPreferencesSchema.parse({ notifications: value?.notifications ?? false, systemNotifications: value?.systemNotifications ?? false, reminders: value?.reminders ?? true, reminderDelayMs: value?.reminderDelayMs ?? 600000 });
        },
        openSession: sessionId => { child.uiWorkspace.openSession(sessionId as SessionId); window.focus(); },
        testClaim: async (clientId, signal) => {
          const state = await request<NotificationSnapshot>('notification-state', {}, signal);
          return request<DeliveryClaim>('notification-test', { clientId, generation: state.runtime.generation }, signal);
        },
      });
      face.notifier = client; const stopNotifications = client.start();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const result = await ctx.connection.rpc.call('/api', 'coopanion/navigation', {}, controller.signal);
          if (result.ok && result.value && !controller.signal.aborted) {
            const value = result.value as { sessionId?: unknown };
            if (typeof value.sessionId === 'string') { child.uiWorkspace.openSession(value.sessionId as SessionId); window.focus(); }
          }
        } catch { /* Connection recovery owns transport errors. */ }
        finally { if (!controller.signal.aborted) timer = setTimeout(poll, 750); }
      };
      void poll(); return () => { stopNotifications(); if (face.notifier === client) face.notifier = undefined; controller.abort(); clearTimeout(timer); };
    });
  });
}
