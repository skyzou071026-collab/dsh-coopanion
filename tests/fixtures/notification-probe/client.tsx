import { useState } from 'react';
import { SystemNotifications, type BrowserNotificationApi } from '../../../src/client/system-notifications.ts';
import { noticeId, type DeliveryReceipt } from '../../../src/notification-contract.ts';

export const inject = ['slots', 'connection', 'uiWorkspace'];
export function apply(ctx: any) {
  const record = async (value: unknown) => ctx.connection.rpc.call('/api', 'coopanion-notification-n0/probe', { action: 'record', value });
  const notifier = new SystemNotifications(typeof Notification === 'undefined' ? undefined : Notification as unknown as BrowserNotificationApi,
    (receipt: DeliveryReceipt) => { void record(receipt); }, sessionId => { ctx.uiWorkspace.openSession(sessionId); window.focus(); });
  ctx.effect(() => () => notifier.dispose());
  async function sendProbe() {
    const result = await ctx.connection.rpc.call('/api', 'coopanion-notification-n0/probe', { action: 'session' });
    if (!result.ok) return '测试会话不可用';
    const time = Date.now(), sessionId = result.value.sessionId;
    await record({ type: 'environment', protocol: location.protocol, desktop: (window as any).dshDesktop?.protocolVersion ?? null, ...notifier.status() });
    notifier.deliver({ token: `n0-${time}`, clientId: 'n0-desktop-client', generation: 1, visibilityRevision: 1, expiresAt: time + 60_000,
      notice: { id: noticeId(sessionId, 1, 1, 'completed', 'initial'), sessionId, turn: 1, seq: 1, time, category: 'completed', stage: 'initial',
        title: 'N0 · DSH 通知验证', body: '点击返回通知验证会话。来源为 DSH 应用界面。', requestIds: [] } });
    return `通知已请求；系统送达以实际显示为准。会话：${sessionId}`;
  }
  ctx.effect(() => {
    const timer = setTimeout(() => { void sendProbe().catch(() => record({ type: 'automatic-probe-failed' })); }, 1000);
    return () => clearTimeout(timer);
  });
  function Probe() {
    const [text, setText] = useState('点击申请权限，然后发送测试通知。');
    async function request() {
      try { const status = await notifier.requestPermission(); setText(JSON.stringify(status)); await record({ type: 'permission', ...status }); }
      catch { setText('权限申请失败'); await record({ type: 'permission-failed' }); }
    }
    async function send() {
      setText(await sendProbe());
    }
    return <section style={{ color: 'var(--dsw-alias-text-primary)', padding: 16 }}>
      <h2>N0 通知验证</h2><p>验证 DSH 应用身份、系统通知送达及点击会话。</p>
      <button onClick={() => void request()}>申请网页通知权限</button>{' '}
      <button onClick={() => void send()}>发送 N0 测试通知</button>
      <p role="status">{text}</p>
    </section>;
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'coopanion-notification-n0', order: 61, label: () => 'N0 通知验证' }, Probe));
}
