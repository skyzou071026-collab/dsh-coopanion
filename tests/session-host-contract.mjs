import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
// Signed Electron rejects NODE_OPTIONS; explicitly propagate only verifier flags.
const nodeArgs = process.execArgv.filter(arg => arg === '--expose-internals' || arg.startsWith('--import='));
const { values } = parseArgs({ options: { runtime: { type: 'string' }, version: { type: 'string' }, package: { type: 'string' }, 'verify-plugin': { type: 'boolean', default: false }, probe: { type: 'string' } } });
assert.ok(values.runtime && values.version && values.package, 'provide --runtime --version --package');
const runtime = resolve(values.runtime), archive = resolve(values.package), modules = join(runtime, 'node_modules');
const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'coopanion-m2-'))), home = join(root, 'home'), profile = join(home, 'profiles/m2');
const cli = join(modules, '@deepseek-ai/dsh/lib/bin.js');
const probe = resolve(values.probe ?? 'tests/fixtures/session-host.mjs');
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_cache: resolve('.cache/npm-cache'), M2_VERIFY_PLUGIN: values['verify-plugin'] ? '1' : '0', M2_MODULES: modules, M2_PLUGIN: join(profile, 'node_modules', '@takboo/dsh-coopanion'), XDG_CONFIG_HOME: root, XDG_CACHE_HOME: join(root, 'cache'), PATH: `${resolve('node_modules/.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
if (process.platform === 'win32') for (const key of Object.keys(env)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
const report = { kind: 'published-profile-loader-controlled-model', version: values.version, node: process.version, platform: process.platform, sourceDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), probeSha256: createHash('sha256').update(await readFile(probe)).digest('hex'), packages: {} };
let host, logs = '';
try {
  for (const name of ['dsh', 'dsh-api-session-controller', 'dsh-agent-loop', 'dsh-session', 'dsh-session-persistence', 'dsh-session-query']) {
    const base = join(modules, '@deepseek-ai', name);
    assert.equal(JSON.parse(await readFile(join(base, 'package.json'), 'utf8')).version, values.version);
    report.packages[name] = createHash('sha256').update(await readFile(join(base, name === 'dsh' ? 'lib/bin.js' : 'lib/index.js'))).digest('hex');
  }
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  const installer = spawn(process.execPath, [...nodeArgs, cli, 'plugin', '--profile', 'm2', 'add', archive], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const installTimer = setTimeout(() => installer.kill('SIGKILL'), 240000);
  let installation = ''; installer.stdout.on('data', c => installation += c); installer.stderr.on('data', c => installation += c);
  try { assert.equal((await once(installer, 'exit'))[0], 0, installation); } finally { clearTimeout(installTimer); }
  // Keep the probe outside the source package, as in the native install observer.
  const observer = join(root, 'observer'), fixture = join(observer, 'host.mjs');
  await mkdir(observer, { recursive: true });
  await writeFile(join(observer, 'package.json'), JSON.stringify({ name: 'coopanion-m2-observer', private: true, type: 'module' }));
  await writeFile(fixture, await readFile(probe));
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: m2-contract\n      name: ${JSON.stringify(fixture)}\n- id: dsh-coopanion\n  config:\n    autoStart: false\n`);
  host = spawn(process.execPath, [...nodeArgs, cli, '--profile', 'm2', '--no-open', '--port', '0'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  host.stdout.on('data', c => logs = (logs + c).slice(-20000)); host.stderr.on('data', c => logs = (logs + c).slice(-20000));
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`M2 host timed out: ${logs}`)), 60000);
    host.on('message', message => { if (message?.type === 'm2-result') { clearTimeout(timer); message.error ? rej(new Error(message.error)) : res(message.result); } });
    host.on('exit', code => { clearTimeout(timer); rej(new Error(`Host exited ${code}: ${logs}`)); });
  });
  Object.assign(report, result);
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally {
  if (host?.connected) { const done = once(host, 'exit'); host.send({ type: 'shutdown-host' }); const timer = setTimeout(() => host.kill('SIGKILL'), 10000); const [code, signal] = await done; clearTimeout(timer); assert.equal(signal, null, 'Host clean shutdown'); assert.equal(code, 0, 'Host exit status'); }
  await mkdir('artifacts', { recursive: true }); await writeFile(`artifacts/session-host-${values.version}.json`, JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
console.log(`M2 published loader contract passed: ${values.version}`);
