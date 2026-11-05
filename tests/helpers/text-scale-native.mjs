import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { petClick } from './native-pointer.mjs';
import { sampleNativeDisplay } from './multi-display-native.mjs';

export async function verifyNativeTextScale({ page, bridge, snapshot }) {
  const reply = { id: 'native-scale-result', sessionId: snapshot.sessionId, text: '## Native text scale\n\n' + '原生窗口阅读与字号独立。 Reading remains captured.\n\n'.repeat(25), time: 1, read: false };
  bridge.update({ ...snapshot, results: [reply], sessions: snapshot.sessions.map(s => ({ ...s, replyId: reply.id, reply: reply.text })) });
  await petClick(page, {}, true);
  await page.locator('#chat-read').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  const html = await page.locator('#reader-text').innerHTML();
  await page.locator('#reader-text').evaluate(n => n.scrollTop = 120);
  const samples = [];
  for (const locale of ['zh', 'en']) for (const size of [90, 240]) for (const textScale of [1, 1.25, 1.5]) {
    bridge.configure({ size, textScale, locale, roam: false, notifications: true, bubbleDurationMs: 12000 });
    await page.waitForFunction(scale => getComputedStyle(document.querySelector('#reader-text')).fontSize === `${14 * scale}px`, textScale);
    const rect = await page.locator('#reader').evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, W: innerWidth, H: innerHeight }; });
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= rect.W && rect.bottom <= rect.H, 'native reader remains in current work area');
    assert.equal(await page.locator('#reader-text').innerHTML(), html);
    assert.equal(await page.locator('#reader-text').evaluate(n => n.scrollTop), 120);
    samples.push({ locale, size, textScale, rect, display: await sampleNativeDisplay(page, '#reader-text') });
  }
  await page.screenshot({ path: 'artifacts/text-scale-native.png' });
  await page.keyboard.press('Escape');
  await petClick(page, {}, true); await page.locator('#message').fill('native preserved draft');
  for (const textScale of [1, 1.25, 1.5]) bridge.configure({ size: 150, textScale, locale: 'zh', roam: false, notifications: true, bubbleDurationMs: 12000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#message')).fontSize === '19.5px');
  assert.equal(await page.locator('#message').inputValue(), 'native preserved draft');
  await page.locator('#message').fill(''); await page.keyboard.press('Escape');
  bridge.configure({ size: 150, textScale: 1, locale: 'zh', roam: false, notifications: true, bubbleDurationMs: 12000 });
  await writeFile('artifacts/text-scale-native.json', JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch, samples, capturedReader: true, scrollRetained: true, draftRetained: true }, null, 2) + '\n');
}
