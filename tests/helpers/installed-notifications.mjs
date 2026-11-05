import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

/** Controlled browser adapter; OS delivery is verified separately in signed Desktop. */
export async function prepareNotifications(page) {
  await page.addInitScript(() => {
    window.__notificationInstall = { objects: [], permissionRequests: 0 };
    window.Notification = class {
      static permission = 'default';
      static async requestPermission() { window.__notificationInstall.permissionRequests++; return this.permission = 'granted'; }
      onshow = null; onclick = null; onerror = null; onclose = null;
      constructor(title, options) {
        this.title = title; this.options = options; window.__notificationInstall.objects.push(this);
        queueMicrotask(() => this.onshow?.());
      }
      close() {}
    };
  });
}

export async function verifyInstalledNotifications({ page, surface, profile, version, hostUrl, project }) {
  const system = surface.getByRole('switch', { name: '系统通知', exact: true });
  const reminders = surface.getByRole('switch', { name: '待处理请求补提醒', exact: true });
  const delay = surface.getByRole('spinbutton', { name: '补提醒等待时间', exact: true });
  assert.equal(await surface.getByRole('switch', { name: '任务通知', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await system.getAttribute('aria-checked'), 'false');
  assert.equal(await reminders.getAttribute('aria-checked'), 'true');
  assert.equal(await delay.inputValue(), '10');
  await delay.fill('1'); await delay.press('Enter');
  await surface.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await reminders.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="待处理请求补提醒"]').getAttribute('aria-checked') === 'false');
  await system.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="系统通知"]').getAttribute('aria-checked') === 'true');
  assert.equal(await page.evaluate(() => window.__notificationInstall.permissionRequests), 1);
  const document = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.match(document, /systemNotifications: true/); assert.match(document, /reminders: false/); assert.match(document, /reminderDelayMs: 60000/);
  await surface.getByRole('button', { name: '隐藏桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '已隐藏' }).waitFor();
  const receipts = [];
  const observe = async response => {
    if (!response.url().endsWith('/api/coopanion/notification-receipt')) return;
    const receipt = response.request().postDataJSON().payload;
    const envelope = await response.json(); receipts.push({ receipt, accepted: envelope.result?.value?.accepted });
  };
  page.on('response', observe);
  const claims = [];
  try {
    for (let n = 0; n < 2; n++) {
      const response = page.waitForResponse(value => value.url().endsWith('/api/coopanion/notification-test'));
      await surface.getByRole('button', { name: '测试系统通知', exact: true }).click();
      const envelope = await (await response).json(); assert.equal(envelope.result.ok, true);
      const claim = envelope.result.value; claims.push(claim);
      assert.ok(claim.visibilityRevision > 0); assert.ok(claim.generation > 0);
      assert.deepEqual(JSON.parse(claim.notice.id), [claim.notice.sessionId, claim.notice.turn, claim.notice.seq, 'reply', 'initial']);
      await page.waitForFunction(id => window.__notificationInstall.objects.some(value => value.options.tag === id), claim.notice.id);
      for (let attempt = 0; attempt < 100 && !receipts.some(value => value.receipt.token === claim.token && value.receipt.state === 'shown'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      const delivered = receipts.filter(value => value.receipt.token === claim.token);
      assert.deepEqual(delivered.map(value => value.receipt.state), ['requested', 'shown']);
      assert.ok(delivered.every(value => value.accepted === true && value.receipt.clientId === claim.clientId && value.receipt.noticeId === claim.notice.id && value.receipt.generation === claim.generation));
    }
    assert.equal(claims[0].notice.sessionId, claims[1].notice.sessionId, 'tests reuse one persisted source within the plugin lifetime');
    assert.notEqual(claims[0].notice.id, claims[1].notice.id, 'each test turn has its own full notice identity');
    assert.notEqual(claims[0].token, claims[1].token);
    const url = new URL('/api/session.export', hostUrl); url.searchParams.set('sessionId', claims[0].notice.sessionId); url.searchParams.set('includeDescendants', 'true');
    const exported = await page.request.get(url.href); assert.equal(exported.status(), 200);
    const files = unzipSync(await exported.body());
    const lines = Buffer.from(files['session.v4.jsonl']).toString('utf8').trim().split('\n').map(value => JSON.parse(value));
    assert.equal(lines[0].id, claims[0].notice.sessionId);
    for (const claim of claims) assert.ok(lines.slice(1).some(event => event.seq === claim.notice.seq && event.type === 'turn/end' && event.data.turn === claim.notice.turn));
    await writeFile(join(project, 'artifacts', `notification-integration-${version}.json`), JSON.stringify({ status: 'pass', dsh: version, mode: 'installed-host-controlled-web-adapter', osDelivery: 'pending', oldConfigurationDefaults: true, persistedPreferences: { systemNotifications: true, reminders: false, reminderDelayMs: 60000 }, claims, receipts, exportedHeader: lines[0] }, null, 2) + '\n');
  } finally { page.off('response', observe); }
  await surface.getByRole('button', { name: '显示桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
}
