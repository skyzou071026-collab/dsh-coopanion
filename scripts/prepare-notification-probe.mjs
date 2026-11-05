import { build } from 'esbuild';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const dir = resolve('.cache/notification-n0/probe');
const id = '@local/coopanion-notification-n0';
await mkdir(dir, { recursive: true });
await copyFile('tests/fixtures/notification-probe/host.mjs', `${dir}/index.mjs`);
await build({ entryPoints: ['tests/fixtures/notification-probe/client.tsx'], outfile: `${dir}/client.js`, bundle: true, external: ['react', 'react/jsx-runtime'], platform: 'browser', format: 'cjs', target: 'chrome130', jsx: 'automatic',
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` }, footer: { js: 'return module.exports; } });' } });
await writeFile(`${dir}/package.json`, JSON.stringify({ name: id, version: '0.4.4', private: true, type: 'module', description: 'Local N0 notification verification fixture', exports: { '.': './index.mjs', './client': './client.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-workspace'] } } }, null, 2) + '\n');
await writeFile(`${dir}/cordis.patch.yml`, `- insert:\n    - id: coopanion-notification-n0\n      name: '${id}'\n- id: webserver\n  config:\n    port: 0\n    host: 127.0.0.1\n`);
await mkdir(`${dir}/locale`, { recursive: true });
await writeFile(`${dir}/locale/en.json`, JSON.stringify({ meta: { title: 'N0 Notification Probe', description: 'Verify application identity, delivery and session click.' } }) + '\n');
await writeFile(`${dir}/locale/zh.json`, JSON.stringify({ meta: { title: 'N0 通知验证', description: '验证应用身份、送达和会话点击。' } }) + '\n');
await writeFile(`${dir}/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4"/></svg>\n');
const hashes = {};
for (const path of ['index.mjs', 'client.js', 'package.json', 'cordis.patch.yml']) hashes[path] = createHash('sha256').update(await readFile(`${dir}/${path}`)).digest('hex');
await writeFile(resolve('.cache/notification-n0/prototype.json'), JSON.stringify({ kind: 'local-private-prototype', version: '0.4.4', hashes }, null, 2) + '\n');
console.log(dir);
