/** Controlled installation/launch only. Sampling is delegated to the passive standalone CLI. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { listDiagnostics, readDiagnostics } from './diagnostics-client.mjs';

const { values: args } = parseArgs({ options: Object.fromEntries(
  ['runtime', 'package', 'output', 'source-commit', 'version', 'seconds', 'interval', 'window', 'warmup'].map(key => [key, { type: 'string' }])
) });
assert.equal(process.platform, 'linux');
for (const name of ['runtime', 'package', 'output', 'source-commit']) assert.ok(args[name], '--' + name + ' is required');
assert.match(args['source-commit'], /^[a-f0-9]{40}$/);
assert.ok(process.env.DISPLAY);
const runtime = resolve(args.runtime), archivePath = resolve(args.package), output = resolve(args.output);
const version = args.version ?? '0.2.0-rc.2';
assert.ok(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).engines.dsh.split(' || ').includes(version));
const seconds = Number(args.seconds ?? 7200), interval = Number(args.interval ?? 5), windowSeconds = Number(args.window ?? 1800), warmup = Number(args.warmup ?? 20);
assert.ok([seconds, interval, windowSeconds, warmup].every(Number.isFinite) && seconds >= windowSeconds * 2 && windowSeconds >= 10 && interval >= 1 && interval <= 10 && warmup >= 20);
await mkdir(dirname(output), { recursive: true }); await mkdir(output);
const work = join(output, 'work'); await mkdir(work);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = hash(await readFile(archivePath));
await copyFile(archivePath, join(output, 'candidate.tgz'));
const home = join(work, 'dsh'), profileName = 'p1-observation', profile = join(home, 'profiles', profileName);
const registry = join(work, 'diagnostics');
const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  PATH: fileURLToPath(new URL('../node_modules/.bin/', import.meta.url)) + ':' + process.env.PATH,
  electron_config_cache: process.env.electron_config_cache ?? join(homedir(), '.cache', 'electron'),
  DSH_PET_TEST_DATA_DIR: join(work, 'pet'), DSH_PET_TEST_DIAGNOSTICS_DIR: registry, DSH_PET_TEST_NO_SANDBOX: '1',
  XDG_CONFIG_HOME: join(work, 'config'), XDG_CACHE_HOME: join(work, 'cache'), XDG_DATA_HOME: join(work, 'data'), XDG_STATE_HOME: join(work, 'state'),
};
let host, browser, sampler, interrupted = false, complete = false, logFile;
const pause = ms => new Promise(r => setTimeout(r, ms));
const signal = () => { interrupted = true; sampler?.kill('SIGTERM'); };
process.on('SIGTERM', signal); process.on('SIGINT', signal);
const log = async entry => { const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'; process.stdout.write(line); await logFile?.write(line); };
async function command(commandArgs, label, timeoutMs = 300000) {
  const file = await open(join(output, label + '.log'), 'wx');
  const child = spawn(process.execPath, commandArgs, { cwd: work, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let writes = Promise.resolve(); const append = chunk => { writes = writes.then(() => file.write(chunk)); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try { const [code, signal] = await once(child, 'exit'); await writes; assert.equal(code, 0, label + ' failed (' + signal + '), see log'); }
  finally { clearTimeout(timer); await file.close(); }
}
async function stopHost() {
  if (!host) return;
  const killGroup = () => { try { process.kill(-host.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  if (host.exitCode !== null || host.signalCode !== null) { killGroup(); return; }
  const ended = once(host, 'exit');
  if (host.connected) host.send({ type: 'shutdown-observation' }, () => {}); else host.kill('SIGTERM');
  const timer = setTimeout(killGroup, 10000);
  try { await ended; } finally { clearTimeout(timer); killGroup(); }
}
try {
  logFile = await open(join(output, 'events.ndjson'), 'wx');
  const cli = join(runtime, 'node_modules', '@deepseek-ai/dsh/lib/bin.js');
  assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules', '@deepseek-ai/dsh/package.json'), 'utf8')).version, version);
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'p1-observation-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  await command([cli, 'plugin', '--profile', profileName, 'add', archivePath], 'plugin-install', 600000);
  const installed = join(profile, 'node_modules', '@takboo/dsh-coopanion');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(installed, 'dist/build-info.json'), 'utf8'));
  assert.equal(build.commit, args['source-commit'], 'Archive source commit mismatch');
  const scriptNames = ['sample-companion.mjs', 'diagnostics-client.mjs', 'resource-observation.mjs'];
  const samplerHashes = {};
  for (const name of scriptNames) {
    const observerBytes = await readFile(fileURLToPath(new URL('./' + name, import.meta.url)));
    const packagedBytes = await readFile(join(installed, 'scripts', name));
    assert.equal(hash(observerBytes), hash(packagedBytes), 'Sampler differs from frozen candidate: ' + name);
    samplerHashes[name] = hash(observerBytes);
  }
  const electronPackage = join(profile, 'node_modules', 'electron');
  assert.equal(JSON.parse(await readFile(join(electronPackage, 'package.json'), 'utf8')).version, manifest.dependencies.electron);
  await command([join(electronPackage, 'install.js')], 'electron-prepare');
  assert.equal(execFileSync(join(electronPackage, 'dist/electron'), ['--no-sandbox', '--version'], { env: environment, encoding: 'utf8', timeout: 10000 }).trim(), 'v' + manifest.dependencies.electron);
  const observer = join(work, 'observer'); await mkdir(observer);
  await writeFile(join(observer, 'package.json'), JSON.stringify({ name: 'p1-resource-observer', private: true, type: 'module' }));
  await writeFile(join(observer, 'host.mjs'), [
    "export const inject = ['appReady', 'appExit', 'settings'];", 'export function apply(ctx) {',
    "ctx.effect(() => { const listener = value => { if (value?.type === 'shutdown-observation') ctx.appExit(0); }; process.on('message', listener); return () => process.off('message', listener); });",
    'ctx.effect(() => ctx.appReady.onReady(async () => {',
    "const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).filter(fiber => fiber.parent.fiber.runtime?.name === 'dsh-coopanion');",
    'const errors = []; for (const fiber of fibers) { try { await fiber.await(); } catch (error) { errors.push(String(error)); } }',
    "process.send?.({ type: 'observation-ready', errors, settings: ctx.settings.describe().find(entry => entry.ns === 'dsh-coopanion')?.value });", '})); }',
  ].join('\n'));
  await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: observation\n      name: ' + JSON.stringify(join(observer, 'host.mjs')) +
    '\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n- id: dsh-coopanion\n  config:\n    autoStart: true\n    size: 180\n    roam: true\n    diagnostics: true\n    companionship: interactive\n');
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  environment.DSH_PET_TEST_DEBUG_PORT = String(listener.address().port); await new Promise(r => listener.close(r));
  const hostOut = await open(join(output, 'host.log'), 'wx'); let hostWrites = Promise.resolve();
  host = spawn(process.execPath, [cli, '--profile', profileName, '--no-open', '--port', '0'], { cwd: work, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const appendHost = chunk => { hostWrites = hostWrites.then(() => hostOut.write(chunk)); };
  host.stdout.on('data', appendHost); host.stderr.on('data', appendHost);
  host.once('exit', () => { void hostWrites.then(() => hostOut.close()); });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error('Host startup timed out')), 120000);
    const receive = value => { if (value?.type === 'observation-ready') finish(null, value); };
    const ended = (code, signal) => finish(new Error('Host exited: ' + (signal ?? code)));
    const failed = error => finish(error);
    function finish(error, value) { clearTimeout(timer); host.off('message', receive); host.off('exit', ended); host.off('error', failed); error ? reject(error) : resolveReady(value); }
    host.on('message', receive); host.once('exit', ended); host.once('error', failed);
  });
  assert.deepEqual(ready.errors, []); assert.equal(ready.settings.diagnostics, true);
  let nativeReady = false;
  for (let attempt = 0; attempt < 300 && !interrupted; attempt++) {
    if (host.exitCode !== null) throw new Error('Host exited before native readiness');
    const endpoint = await fetch('http://127.0.0.1:' + environment.DSH_PET_TEST_DEBUG_PORT + '/json/version', { signal: AbortSignal.timeout(1000) }).then(r => r.ok ? r.json() : null, () => null);
    if (endpoint?.webSocketDebuggerUrl) { nativeReady = true; break; } await pause(100);
  }
  assert.ok(nativeReady);
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + environment.DSH_PET_TEST_DEBUG_PORT);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#pet[data-host-ready=true][data-character=whale][data-companionship=interactive]');
  await page.addInitScript(() => { let seed = 17; Math.random = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; }; });
  await page.reload(); await page.waitForSelector('#pet[data-host-ready=true][data-character=whale][data-companionship=interactive]');
  await page.mouse.move(0, 0);
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  const graphics = await frame.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2'), extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: !!gl, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null };
  });
  assert.ok(graphics.webgl2);
  await page.screenshot({ path: join(output, 'start.png') });
  await log({ phase: 'warmup', seconds: warmup, graphics }); await pause(warmup * 1000);
  const [endpoint] = await listDiagnostics(registry); assert.ok(endpoint);
  const initial = await readDiagnostics(endpoint); assert.ok(initial.value.renderer);
  assert.equal(initial.build.productDigest, build.productDigest);
  await writeFile(join(output, 'metadata.json'), JSON.stringify({ schema: 2, sourceCommit: args['source-commit'], archiveSha256, pluginVersion: manifest.version, dshVersion: version, build,
    samplerHashes, graphics, node: process.version, platform: process.platform, arch: process.arch,
    mode: 'interactive', rngSeed: 17, clock: 'real time; no local-hour override', warmupSeconds: warmup, requestedSeconds: seconds, intervalSeconds: interval, windowSeconds,
    hostPid: host.pid, electronPid: endpoint.pid, initialSnapshot: initial,
    instrumentation: 'CDP only for initial RNG/visibility/render proof; no test-page instrumentation. All periodic sampling uses the standalone sampler and product diagnostic interface.',
    sandbox: 'Isolated existing virtual-display test flags; ordinary local installation retains sandbox and has no debug port.',
  }, null, 2) + '\n', { flag: 'wx' });
  await log({ phase: 'sampling', archiveSha256, samplerHashes, requestedSeconds: seconds });
  sampler = spawn(process.execPath, [fileURLToPath(new URL('./sample-companion.mjs', import.meta.url)), '--registry', registry, '--instance', endpoint.instance,
    '--seconds', String(seconds), '--interval', String(interval), '--window', String(windowSeconds), '--expect-version', manifest.version,
    '--expect-product-digest', build.productDigest, '--strict', '--output', join(output, 'sampling')], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  sampler.stdout.on('data', chunk => process.stdout.write(chunk)); sampler.stderr.on('data', chunk => process.stderr.write(chunk));
  const [code, samplerSignal] = await once(sampler, 'exit');
  const summary = JSON.parse(await readFile(join(output, 'sampling/summary.json'), 'utf8'));
  const result = { ...summary, sourceCommit: args['source-commit'], archiveSha256, dshVersion: version, graphics };
  await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  complete = !interrupted && code === 0;
  await log({ phase: 'finished', status: result.status, fullTwoHourObservation: result.fullTwoHourObservation, code, signal: samplerSignal });
  if (!complete) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  await writeFile(join(output, 'failure.json'), JSON.stringify({ status: 'incomplete', at: new Date().toISOString(), error: String(error.stack ?? error), sourceCommit: args['source-commit'], archiveSha256 }, null, 2) + '\n', { flag: 'wx' });
  await log({ phase: 'failed', error: String(error.message ?? error) });
} finally {
  if (sampler?.exitCode === null && sampler.signalCode === null) sampler.kill('SIGTERM');
  await browser?.close().catch(() => {}); await stopHost(); await logFile?.close();
  process.off('SIGTERM', signal); process.off('SIGINT', signal);
}
