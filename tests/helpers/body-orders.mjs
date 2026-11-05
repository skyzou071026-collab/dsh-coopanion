import assert from 'node:assert/strict';

export async function recordBodyOrders(page) {
  const frame = page.frames().find(frame => frame.url().includes('figure-frame.html'));
  assert.ok(frame, 'API 2 sandbox frame exists');
  await frame.evaluate(() => { window.bodyOrders = []; addEventListener('message', e => { if (['do', 'set'].includes(e.data?.t)) window.bodyOrders.push(e.data); }); });
  return frame;
}
