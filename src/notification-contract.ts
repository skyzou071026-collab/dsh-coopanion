import { z } from 'zod';

/** Shared N0 contract. Host owns request truth and delivery claims; views render it. */
export const NOTIFICATION_PROTOCOL = 1 as const;
const id = z.string().min(1).max(2048);
const counter = z.number().int().nonnegative().safe();
export const notificationPreferencesSchema = z.object({
  notifications: z.boolean().default(true),
  systemNotifications: z.boolean().default(false),
  reminders: z.boolean().default(true),
  reminderDelayMs: z.number().int().min(60_000).max(86_400_000).default(600_000),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const noticeSchema = z.object({
  id, sessionId: id, turn: counter, seq: counter, time: counter,
  category: z.enum(['reply', 'goal-progress', 'completed', 'approval', 'question', 'error', 'stopped', 'interrupted', 'blocked', 'max-tokens']),
  goal: z.object({ id, revision: counter.positive(), round: counter }).strict().optional(),
  stage: z.enum(['initial', 'reminder']),
  title: z.string().max(256), body: z.string().max(2048),
  requestIds: z.array(id).max(100).default([]), source: z.enum(['event', 'runtime']).optional(),
}).strict();
export type TaskNotice = z.infer<typeof noticeSchema>;
/** Tuple encoding preserves complete identities even when they contain separators. */
export function noticeId(sessionId: string, turn: number, seq: number, category: TaskNotice['category'], stage: TaskNotice['stage'], occurrence = 0, runtimeId?: string): string {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error('Invalid notification occurrence');
  if (runtimeId !== undefined && !runtimeId.length) throw new Error('Invalid runtime request id');
  const tuple: (string | number)[] = [sessionId, turn, seq, category, stage];
  if (runtimeId !== undefined) tuple.push(runtimeId);
  if (occurrence > 0) tuple.push(occurrence);
  return JSON.stringify(tuple);
}
export function interactionId(sessionId: string, kind: 'approval' | 'question', nativeId: string): string {
  return JSON.stringify([sessionId, kind, nativeId]);
}
export const interactionSchema = z.object({
  id, sessionId: id, nativeId: id, kind: z.enum(['approval', 'question']),
  turn: counter, seq: counter, createdAt: counter, preview: z.string().max(2048),
  state: z.enum(['open', 'continued', 'settled']), source: z.enum(['event', 'runtime']).optional(),
  dueAt: counter.nullable(), automaticReminders: z.number().int().min(0).max(1),
}).strict();
export type PendingInteraction = z.infer<typeof interactionSchema>;
export const runtimeSchema = z.object({
  phase: z.enum(['stopped', 'starting', 'running', 'stopping', 'recovering', 'error']),
  generation: counter, visibilityRevision: counter, visible: z.boolean(),
  suspended: z.boolean(), error: z.string().max(600).optional(),
  desiredVisible: z.boolean().optional(), recoveryAttempt: counter.max(3).optional(), retryAt: counter.optional(),
}).strict();
export type NotificationRuntime = z.infer<typeof runtimeSchema>;
export const deliveryClaimSchema = z.object({
  token: id, clientId: id, generation: counter, visibilityRevision: counter,
  expiresAt: counter, notice: noticeSchema,
}).strict();
export type DeliveryClaim = z.infer<typeof deliveryClaimSchema>;
export const deliveryReceiptSchema = z.object({
  token: id, clientId: id, noticeId: id, generation: counter,
  state: z.enum(['requested', 'shown', 'clicked', 'failed', 'unknown']),
  time: counter, detail: z.string().max(600).optional(),
}).strict();
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export interface NotificationSnapshot {
  protocol: typeof NOTIFICATION_PROTOCOL;
  runtime: NotificationRuntime;
  interactions: PendingInteraction[];
}
export const notificationRequests = {
  state: z.object({ locale: z.string().min(2).max(64).regex(/^[a-zA-Z0-9-]+$/).optional() }).strict(),
  claim: z.object({ clientId: id, generation: counter }).strict(),
  receipt: deliveryReceiptSchema,
  test: z.object({ clientId: id, generation: counter }).strict(),
  snooze: z.object({ interactionId: id, generation: counter }).strict(),
} as const;
/** Paths are carried by authenticated DSH Connection, with server-issued claim tokens. */
export const notificationEndpoints = ['notification-state', 'notification-claim', 'notification-receipt', 'notification-snooze', 'notification-test'] as const;

export interface WebNotificationStatus {
  supported: boolean;
  permission: NotificationPermission | 'unavailable';
  osAuthorization: 'unknown';
}
