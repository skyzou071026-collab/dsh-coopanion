import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitRecovery(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(40); }
  assert.fail(description);
}
export async function crashNative(browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const main = processInfo.find(process => process.type === 'browser');
  assert.ok(main?.id > 0, 'CDP identifies the real native browser process');
  process.kill(main.id, 'SIGKILL');
  return main.id;
}
export async function connectRecovered(port) {
  let browser;
  await waitRecovery(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true; }
    catch { return false; }
  }, 'recovered native debug endpoint did not become ready');
  return browser;
}
