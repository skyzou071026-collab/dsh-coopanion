import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { previewServer } from './preview.mjs';
const server = previewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-character=whale][data-mode]');
  await page.evaluate(() => { document.body.classList.remove('preview'); document.getElementById('demo').hidden = true; });
  await page.addStyleTag({ content: '* { animation: none !important; } #pet, .bubble, .panel, .menu, #toast { visibility: hidden !important; }' });
  await page.locator('#body-layer iframe').contentFrame().locator('canvas').screenshot({ path: 'desktop/icon.png', omitBackground: true });
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
