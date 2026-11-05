import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { importCharacter } from './helpers/characters.mjs';
import { petClick } from './helpers/native-pointer.mjs';
import { listDiagnostics, readDiagnostics } from '../scripts/diagnostics-client.mjs';
import { sampleNativeDisplay } from './helpers/multi-display-native.mjs';
import { npmTarballName } from '../scripts/release-support.mjs';
import { unzipSync } from 'fflate';
import { prepareNotifications, verifyInstalledNotifications } from './helpers/installed-notifications.mjs';
import { crashNative, connectRecovered, waitRecovery } from './helpers/desktop-recovery.mjs';

// Electron virtualizes .asar paths; cleanup must remove the physical archives.
const removeTree = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises.rm : rm;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const version = process.env.DSH_TEST_VERSION ?? '0.2.0-rc.2';
const project = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
assert.ok(manifest.engines.dsh.split(' || ').includes(version), 'test only advertised DSH versions');
const archive = resolve(process.env.DSH_TEST_PACKAGE ?? (process.env.DSH_TEST_PACKAGE_DIR
  ? join(process.env.DSH_TEST_PACKAGE_DIR, `dsh-coopanion-${manifest.version}.tgz`)
  : join(project, npmTarballName(manifest))));
assert.ok(existsSync(archive), 'run npm pack before the installation test');
// Windows TEMP can be an 8.3 alias (RUNNER~1). Use one physical path for the
// CLI and profile loaders so stateful host modules share the same ESM identity.
const root = realpathSync.native(await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-coopanion-install-')));
const runtime = process.env.DSH_TEST_RUNTIME ? resolve(process.env.DSH_TEST_RUNTIME) : join(root, 'runtime');
const home = join(root, 'home');
const profileName = 'coopanion-install';
const profile = join(home, 'profiles', profileName);
const environment = {
  ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  XDG_CONFIG_HOME: root, XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
  PATH: `${join(project, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  COOPANION_TEST_MODULES: join(runtime, 'node_modules'),
  DSH_PET_TEST_DATA_DIR: join(root, 'pet'), DSH_PET_TEST_DIAGNOSTICS_DIR: join(root, 'diagnostics'), DSH_PET_TEST_NO_SANDBOX: '1',
};
// Windows environment keys are case-insensitive; keep one PATH entry for spawn.
if (process.platform === 'win32') {
  for (const key of Object.keys(environment)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete environment[key];
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitProfile(pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pattern.test(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))) return;
    await pause(100);
  }
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), pattern, 'the Host persisted its locale preference');
}
async function openPetSettings(page, chinese = true) {
  const settingsName = chinese ? '设置' : 'Settings';
  const accountMenu = version.startsWith('0.2.1-rc.');
  const launcher = page.getByRole('button', { name: accountMenu ? (chinese ? '账号菜单' : 'Account menu') : settingsName, exact: true });
  const section = page.getByRole('button', { name: chinese ? '桌宠' : 'Desktop pet', exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await launcher.click();
    if (accountMenu) {
      await page.getByRole('menuitem', { name: settingsName, exact: true }).click();
    }
    try {
      await section.waitFor({ timeout: 5000 });
      await section.click();
      await page.getByTestId('pet-status').filter({ hasNotText: /正在连接|Connecting/ }).waitFor({ timeout: 5000 });
      await page.locator('#coopanion-size:enabled').waitFor({ timeout: 5000 });
      return;
    } catch (error) {
      // DSH closes its panel when initial session/onboarding hydration settles.
      // Reopen only if the public UI confirms it actually closed; a missing
      // plugin section or failed status/configuration load in an open panel must fail.
      const closed = accountMenu ? await page.getByRole('dialog').count() === 0 : await launcher.getAttribute('aria-expanded') === 'false';
      if (attempt !== 0 || !closed) throw error;
      console.log('DSH closed settings during initial onboarding; reopening the native panel.');
    }
  }
}
async function openSessionPicker(page) {
  await petClick(page, {}, true); await page.locator('#chat-current').click();
}
let display, host, browser, settingsBrowser;
let hostUrl;
let settingsPage;
const uiErrors = [];
const consoleErrors = [];
let hostLog = '';

async function run(command, args, cwd = project, timeoutMs = 240000) {
  const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-32000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    return output;
  } finally { clearTimeout(deadline); }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = once(child, 'exit');
  // POSIX uses the launcher's signal shutdown, which exits after disposal.
  // appExit instead waits for natural event-loop quiescence and old hosts can
  // retain handles after disposing. Windows needs the catchable IPC exit hook.
  if (process.platform === 'win32' && child === host && child.connected) child.send({ type: 'shutdown-host' });
  else child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await finished; } finally { clearTimeout(deadline); }
}

try {
  if (!process.env.DSH_TEST_RUNTIME) {
    console.log(`Preparing published DSH ${version} in an isolated test directory…`);
    await mkdir(runtime, { recursive: true });
    const logs = join(project, 'artifacts', `npm-runtime-${version}`);
    await mkdir(logs, { recursive: true });
    assert.ok(process.env.npm_execpath, 'run this test through npm run test:install');
    // Invoke npm's JavaScript entry directly: Windows cannot exec a .cmd without a shell.
    const preparing = Date.now();
    await run(process.execPath, [process.env.npm_execpath, 'install', '--prefix', runtime, '--no-audit', '--no-fund', '--loglevel=info', '--timing', '--logs-dir', logs, `@deepseek-ai/dsh@${version}`], project, process.platform === 'win32' ? 600000 : 240000);
    console.log(`Published DSH ${version} prepared in ${Math.round((Date.now() - preparing) / 1000)}s.`);
  }
  const cliDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh');
  assert.equal(JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8')).version, version);
  const cli = join(cliDir, 'lib', 'bin.js');
  const bootFile = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const { evaluatePluginCompatibility } = await import(pathToFileURL(bootFile).href);
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  for (const supported of manifest.engines.dsh.split(' || ')) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, supported), undefined, `advertised host ${supported} is accepted`);
  }
  const previousHostRange = structuredClone(manifest);
  previousHostRange.engines.dsh = manifest.engines.dsh.split(' || ').filter(v => v !== version).join(' || ');
  for (const peer of Object.keys(previousHostRange.peerDependencies)) {
    if (peer.startsWith('@deepseek-ai/dsh-')) previousHostRange.peerDependencies[peer] = previousHostRange.peerDependencies[peer].split(' || ').filter(v => v !== version).join(' || ');
  }
  assert.ok(evaluatePluginCompatibility(previousHostRange, {}, version), 'declarations without the target reject that host');
  const previous = structuredClone(manifest);
  previous.version = '0.1.0';
  for (const peer of Object.keys(previous.peerDependencies)) {
    if (peer.startsWith('@deepseek-ai/dsh-')) previous.peerDependencies[peer] = '^0.2.1-alpha.1';
  }
  if (version === '0.2.0-rc.2') assert.equal(evaluatePluginCompatibility(previous, {}, version)?.exempted, false, 'reproduce the previous release rejection');
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1'), 'unverified versions remain incompatible');
  for (const unknown of ['0.2.1-rc.4', '99.0.0-rc.1']) {
    if (!manifest.engines.dsh.split(' || ').includes(unknown)) assert.ok(evaluatePluginCompatibility(manifest, {}, unknown), 'unverified versions remain rejected');
  }
  if (version.startsWith('0.2.1-rc.')) {
    const restricted = structuredClone(manifest);
    restricted.engines.dsh = '0.2.0-rc.2';
    assert.ok(evaluatePluginCompatibility(restricted, {}, version), 'new hosts enforce engines.dsh even when peers match');
  }

  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'coopanion-install-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  console.log(`Installing ${manifest.name}@${manifest.version} with the real DSH ${version} plugin command…`);
  const installLog = await run(process.execPath, [cli, 'plugin', '--profile', profileName, 'add', archive]);
  assert.ok(!installLog.includes('installation rejected'), installLog);
  const installedProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(installedProfile.dependencies[manifest.name]);
  assert.ok(installedProfile.dsh.profile.bundles.includes(manifest.name), 'installer discovers and activates the packaged bundle');
  assert.equal(existsSync(join(profile, 'compatibility.json')), false, 'no risk exemption is used');
  const installed = join(profile, 'node_modules', manifest.name);
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, manifest.version);
  await run(process.execPath, [join(project, 'tests/notification-host-contract.mjs'), '--runtime', runtime, '--version', version]);

  await run(process.execPath, [join(project, 'tests/goal-host-contract.mjs'), '--runtime', runtime, '--version', version, '--package', archive]);
  await run(process.execPath, [join(project, 'tests/session-host-contract.mjs'), '--verify-plugin', '--runtime', runtime, '--version', version, '--package', archive]);

  // Keep the observer in its own package. The Client loader identifies packages
  // from ancestor manifests; a fixture inside this repository can be mistaken
  // for a second active copy of the installed dsh-coopanion client.
  const observer = join(root, 'observer');
  await mkdir(observer, { recursive: true });
  await writeFile(join(observer, 'package.json'), JSON.stringify({ name: 'coopanion-install-observer', private: true, type: 'module' }));
  const fixture = join(observer, 'host.mjs');
  await writeFile(fixture, await readFile(fileURLToPath(new URL('./fixtures/host.mjs', import.meta.url))));
  await writeFile(join(observer, 'installed-services.mjs'), await readFile(fileURLToPath(new URL('./helpers/installed-services.mjs', import.meta.url))));
  await writeFile(join(observer, 'notification-probe.mjs'), await readFile(fileURLToPath(new URL('./fixtures/notification-probe/host.mjs', import.meta.url))));
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: install-observer\n      name: ${JSON.stringify(fixture)}\n- id: locale\n  config:\n    preference: zh\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n- id: dsh-coopanion\n  config:\n    autoStart: true\n    size: 150\n    roam: true\n    dailyRhythm: true\n    notifications: true\n    bubbleDurationMs: 12000\n`);
  if (process.platform === 'linux' && !environment.DISPLAY) {
    const number = 100 + process.pid % 1000;
    display = spawn(process.env.XVFB_PATH ?? 'Xvfb', [`:${number}`, '-screen', '0', '1200x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let displayError; display.on('error', error => { displayError = error; });
    for (let n = 0; n < 30 && !existsSync(`/tmp/.X11-unix/X${number}`); n++) {
      if (displayError) throw displayError;
      if (display.exitCode !== null) throw new Error('Xvfb exited before creating its socket');
      await pause(100);
    }
    assert.ok(existsSync(`/tmp/.X11-unix/X${number}`), 'Xvfb is ready');
    process.env.DISPLAY = environment.DISPLAY = `:${number}`;
  }
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  environment.DSH_PET_TEST_DEBUG_PORT = String(port);
  const bootHost = async () => {
    hostLog = '';
    console.log(`Starting the installed bundle through the published DSH ${version} profile loader…`);
    host = spawn(process.execPath, [cli, '--profile', profileName, '--no-open', '--port', '0'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const collect = chunk => { hostLog = (hostLog + chunk.toString()).slice(-32000); };
    host.stdout.on('data', collect); host.stderr.on('data', collect);
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Host startup timed out:\n${hostLog}`)), 120000);
      const ready = message => { if (message?.type === 'host-ready') {
        if (message.services.errors.length) return finish(new Error(message.services.errors.join('\n')));
        assert.equal(message.services.customSettingsPage, true); hostUrl = message.url; finish();
      } };
      const ended = (code, signal) => finish(new Error(`Host exited ${signal ?? code}:\n${hostLog}`));
      const failed = error => finish(error);
      function finish(error) {
        clearTimeout(timeout); host.off('message', ready); host.off('exit', ended); host.off('error', failed);
        if (error) reject(error); else resolveReady();
      }
      host.on('message', ready); host.once('exit', ended); host.once('error', failed);
    });
  };
  await bootHost();
  const serviceCases = await new Promise((resolveCases, reject) => {
    const timeout = setTimeout(() => finish(new Error('Installed service integration timed out')), 10000);
    const receive = message => { if (message?.type === 'installed-services-verified') finish(message.error ? new Error(message.error) : undefined, message.cases); };
    const ended = (code, signal) => finish(new Error(`Host exited during service verification: ${signal ?? code}`));
    function finish(error, cases) { clearTimeout(timeout); host.off('message', receive); host.off('exit', ended); if (error) reject(error); else resolveCases(cases); }
    host.on('message', receive); host.once('exit', ended);
    host.send({ type: 'verify-installed-services', helper: join(observer, 'installed-services.mjs'), modules: join(runtime, 'node_modules'), plugin: installed });
  });
  const contractReportPath = join(project, 'artifacts', `notification-host-${version}.json`);
  const contractReport = JSON.parse(await readFile(contractReportPath, 'utf8'));
  contractReport.integration = { kind: 'installed-plugin-published-services', loader: 'published-dsh-host', nativeVisibility: 'controlled', humanAnswers: 'controlled', model: 'not-used', cases: serviceCases };
  await writeFile(contractReportPath, JSON.stringify(contractReport, null, 2) + '\n');
  // Harness readiness is independent of the asynchronous pet launch. Attach
  // only after the actual Electron debug endpoint reports an available target.
  let nativeReady = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    assert.equal(host.exitCode, null, hostLog);
    const endpoint = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok ? response.json() : null, () => null);
    if (endpoint?.webSocketDebuggerUrl) { nativeReady = true; break; }
    await pause(100);
  }
  assert.ok(nativeReady, `The asynchronously launched native pet did not become ready:\n${hostLog}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => uiErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().split('\n')[0]); });
  await page.waitForSelector('#pet');
  assert.equal(await page.locator('#demo').isVisible(), false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.waitForSelector('#pet[data-character=whale]');
  await petClick(page, { button: 'right' }); await page.locator('#open-characters').click();
  await importCharacter(page, join(process.env.DSH_TEST_PACKAGE_DIR ?? project, 'paper-star.zip'));
  await page.waitForFunction(() => document.getElementById('character-select').value === 'paper-star' && !document.getElementById('character-use').disabled);
  await page.locator('#character-use').click(); await page.waitForSelector('#pet[data-character=paper-star]');
  await page.locator('#character-select').selectOption('whale');
  await page.waitForFunction(() => document.getElementById('character-select').value === 'whale' && !document.getElementById('character-use').disabled);
  await page.locator('#character-use').click(); await page.waitForSelector('#pet[data-character=whale]');
  await page.locator('#characters-close').click();
  host.send({ type: 'start-task' });
  await page.waitForFunction(() => document.getElementById('pet').dataset.mood === 'thinking');
  assert.equal(await page.locator('#bubble').isVisible(), false, 'real Harness thinking uses animation without status speech');
  const logged = new Promise(resolveLog => {
    const receive = message => { if (message?.type === 'session-log') { host.off('message', receive); resolveLog(message.events); } };
    host.on('message', receive);
  });
  host.send({ type: 'finish-task' });
  await page.waitForFunction(() => document.getElementById('pet').dataset.mood === 'idle');
  await page.waitForFunction(() => document.getElementById('bubble-text').textContent === '安装验证的最终回复。任务已完成。');
  assert.equal(await page.locator('#toast').isVisible(), false);
  assert.equal(await page.locator('#attention-count').innerText(), '1', 'a delivered final reply remains unread until the user acknowledges it');
  await page.locator('#dismiss').click();
  await page.waitForFunction(() => document.getElementById('attention').hidden);
  assert.ok((await logged).includes('turn/end'), 'notification comes from the real host session log');
  await page.waitForFunction(() => document.getElementById('pet').dataset.mood === 'idle');
  host.send({ type: 'start-task', sessionId: 'host-other' });
  await page.waitForFunction(() => document.querySelector('#conversation-list [data-session-id="host-other"]'));
  await page.waitForFunction(() => document.getElementById('pet').dataset.mood === 'thinking');
  assert.equal(await page.locator('#chat-session-name').innerText(), '安装验证', 'a new background session preserves the explicit focus');
  await openSessionPicker(page);
  assert.equal(await page.locator('#conversation-list [data-session-id="host-other"]').getAttribute('aria-selected'), 'false');
  await page.locator('#conversation-list [data-session-id="host-other"]').click();
  await page.waitForFunction(() => document.getElementById('chat-session-name').textContent === '第二会话');
  await openSessionPicker(page);
  await mkdir(join(project, 'artifacts'), { recursive: true });
  await page.screenshot({ path: join(project, 'artifacts', `installed-sessions-${version}.png`) });
  await page.locator('#conversation-list [data-session-id="host-install"]').click();
  await page.waitForFunction(() => document.getElementById('chat-session-name').textContent === '安装验证');
  await page.keyboard.press('Escape');
  await mkdir(join(project, 'artifacts'), { recursive: true });
  await page.screenshot({ path: join(project, 'artifacts', `installed-${version}.png`) });
  assert.ok(hostUrl, 'the published DSH web surface is ready');
  settingsBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] });
  const settings = await settingsBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  settingsPage = settings;
  await prepareNotifications(settings);
  settings.on('pageerror', error => uiErrors.push(error.message));
  settings.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().split('\n')[0]); });
  settings.on('response', async response => {
    if (!/settings[/.]mutate/.test(response.url())) return;
    try {
      const request = response.request().postDataJSON();
      if (!JSON.stringify(request.payload).includes('dsh-coopanion')) return;
      const reply = await response.json();
      console.log('DSH preference mutation:', JSON.stringify({ request: request.payload, ok: reply.result?.ok, error: reply.result?.error }));
    } catch (error) { console.error('Settings response diagnostic:', String(error)); }
  });
  await settings.goto(hostUrl);
  await settings.getByRole('button', { name: /^(继续|Continue)$/, exact: true }).click();
  // A queued background result opens its source in the actual Harness client.
  host.send({ type: 'finish-task', sessionId: 'host-other' });
  await page.waitForSelector('#attention:not([hidden])');
  assert.equal(await page.locator('#chat-session-name').innerText(), '安装验证');
  await page.locator('#attention').click();
  await page.waitForFunction(() => document.getElementById('reader-text').textContent === '第二会话的最终回复。任务已完成。');
  assert.equal(await page.locator('#chat-session-name').innerText(), '安装验证', 'reading a background result does not change the live chat target');
  await page.locator('#reader-session').click();
  assert.equal(await page.locator('#chat').isVisible(), true);
  await page.locator('#chat-session').click();
  await settings.getByRole('navigation', { name: '会话层级', exact: true }).filter({ hasText: '第二会话' }).waitFor();
  await openSessionPicker(page); await page.locator('#conversation-list [data-session-id="host-install"]').click();
  await openSessionPicker(page); await page.locator('#conversation-open').click();
  await settings.getByRole('navigation', { name: '会话层级', exact: true }).filter({ hasText: '安装验证' }).waitFor();
  assert.equal(await page.locator('#chat-session-name').innerText(), '安装验证');
  await openPetSettings(settings);
  const surface = settings.getByTestId('coopanion-settings');
  await surface.waitFor();
  console.log('Official DSH settings page loaded; checking controls and persisted preferences…');
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
  await verifyInstalledNotifications({ page: settings, surface, profile, version, hostUrl, project });
  await surface.getByRole('button', { name: '隐藏桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '已隐藏' }).waitFor();
  await surface.getByRole('button', { name: '显示桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
  await surface.getByRole('spinbutton', { name: '角色尺寸', exact: true }).fill('180');
  await surface.getByRole('spinbutton', { name: '角色尺寸', exact: true }).press('Enter');
  await surface.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--size') === '180px');
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /size: 180/, 'native Host settings persist the size');
  assert.equal(await surface.getByRole('combobox', { name: '文字大小', exact: true }).inputValue(), '1', 'old installed config defaults to 100%');
  assert.equal(await surface.getByRole('switch', { name: '日常陪伴节奏', exact: true }).count(), 0);
  assert.equal(await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).inputValue(), 'off');
  await petClick(page, {}, true);
  await page.locator('#message').fill('M4 installed draft');
  await page.locator('#message').evaluate(n => { n.focus(); n.setSelectionRange(2, 7); window.npcInstalledFrame = document.querySelector('#body-layer iframe'); });
  for (const companionship of ['quiet', 'interactive', 'off']) {
    await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).selectOption(companionship);
    await waitProfile(new RegExp('companionship: ' + companionship));
    await page.waitForFunction(mode => document.querySelector('#companion-mode').value === mode, companionship);
    // Profile persistence, native IPC and the official form subscription settle
    // independently. Finish the visible update before changing this select again.
    await settings.waitForFunction(mode => document.querySelector('#coopanion-companionship')?.value === mode, companionship);
    assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n.selectionStart, n.selectionEnd, window.npcInstalledFrame === document.querySelector('#body-layer iframe')]), ['M4 installed draft', 2, 7, true], 'native hot preference preserves draft, selection and API 2 frame');
  }
  assert.equal(await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).inputValue(), 'off');
  for (const [field, percent, fraction] of [['npcHome', 20, '0.2'], ['npcRange', 25, '0.25']]) {
    const input = surface.locator('#coopanion-' + field);
    await input.fill(String(percent)); await input.press('Enter');
    await waitProfile(new RegExp(field + ': ' + fraction.replace('.', '[.]')));
    assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n.selectionStart, n.selectionEnd, window.npcInstalledFrame === document.querySelector('#body-layer iframe')]), ['M4 installed draft', 2, 7, true]);
  }
  const p1Summary = await page.evaluate(() => window.dshPetBridge.companionship({ type: 'read', characterId: 'whale' }));
  assert.equal(p1Summary.writable, true); assert.equal(p1Summary.relation.total, 0);
  assert.equal(await surface.getByRole('switch', { name: '本地诊断', exact: true }).getAttribute('aria-checked'), 'false');
  assert.deepEqual(await listDiagnostics(environment.DSH_PET_TEST_DIAGNOSTICS_DIR), []);
  await surface.getByRole('switch', { name: '本地诊断', exact: true }).click();
  await waitProfile(/diagnostics: true/);
  let diagnosticEndpoint;
  for (let attempt = 0; attempt < 100; attempt++) { [diagnosticEndpoint] = await listDiagnostics(environment.DSH_PET_TEST_DIAGNOSTICS_DIR); if (diagnosticEndpoint) break; await pause(50); }
  assert.ok(diagnosticEndpoint);
  const diagnosticSnapshot = await readDiagnostics(diagnosticEndpoint);
  assert.equal(diagnosticSnapshot.version, manifest.version);
  assert.ok(!JSON.stringify(diagnosticSnapshot).includes('M4 installed draft'));
  assert.deepEqual(await page.locator('#message').evaluate(n => [n.value, n.selectionStart, n.selectionEnd]), ['M4 installed draft', 2, 7]);
  await surface.getByRole('switch', { name: '本地诊断', exact: true }).click();
  await waitProfile(/diagnostics: false/);
  for (let attempt = 0; attempt < 100 && (await listDiagnostics(environment.DSH_PET_TEST_DIAGNOSTICS_DIR)).length; attempt++) await pause(50);
  assert.deepEqual(await listDiagnostics(environment.DSH_PET_TEST_DIAGNOSTICS_DIR), []);
  await writeFile(join(project, 'artifacts', 'diagnostics-installed-' + version + '.json'), JSON.stringify({ dsh: version, pluginVersion: manifest.version, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), build: diagnosticSnapshot.build, defaultOff: true, settingsHotSync: true, draftOmittedAndPreserved: true, interfaceWithdrawn: true }, null, 2) + '\n');
  const textScaleSamples = [];
  for (const size of [90, 240]) {
    const input = surface.getByRole('spinbutton', { name: '角色尺寸', exact: true });
    await input.fill(String(size)); await input.press('Enter');
    await page.waitForFunction(size => getComputedStyle(document.documentElement).getPropertyValue('--size') === `${size}px`, size);
    for (const textScale of [1, 1.25, 1.5]) {
      await surface.getByRole('combobox', { name: '文字大小', exact: true }).selectOption(String(textScale));
      await page.waitForFunction(scale => getComputedStyle(document.querySelector('#message')).fontSize === `${13 * scale}px`, textScale);
      await waitProfile(new RegExp('textScale: ' + String(textScale).replace('.', '[.]') + '(?:\\s|$)'));
      assert.equal(await page.locator('#message').inputValue(), 'M4 installed draft');
      const rect = await page.locator('#chat').evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, W: innerWidth, H: innerHeight }; });
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= rect.W && rect.bottom <= rect.H);
      textScaleSamples.push({ size, textScale, rect, draft: true, persisted: true, display: await sampleNativeDisplay(page) });
    }
  }
  await surface.getByRole('spinbutton', { name: '角色尺寸', exact: true }).fill('180');
  await surface.getByRole('spinbutton', { name: '角色尺寸', exact: true }).press('Enter');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--size') === '180px');
  await page.screenshot({ path: join(project, 'artifacts', `text-scale-installed-${version}.png`) });
  await page.locator('#message').fill(''); await page.keyboard.press('Escape');
  await settings.waitForFunction(() => document.querySelector('.dsh-coopanion-settings [role="switch"][aria-label="闲时走动"]').getAttribute('aria-checked') === 'true');
  await petClick(page, { button: 'right' });
  await page.locator('#toggle-roam').click();
  await surface.getByRole('switch', { name: '闲时走动', exact: true }).waitFor();
  await settings.waitForFunction(() => document.querySelector('.dsh-coopanion-settings [role="switch"][aria-label="闲时走动"]').getAttribute('aria-checked') === 'false');
  await page.waitForFunction(() => document.getElementById('toggle-roam').getAttribute('aria-checked') === 'false');
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /roam: false/, 'desktop menu persists the same Host preference');
  await surface.getByRole('switch', { name: '闲时走动', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toggle-roam').getAttribute('aria-checked') === 'true');
  await waitProfile(/roam: true/);
  await page.keyboard.press('Escape');
  await page.close();
  await surface.getByTestId('pet-status').filter({ hasText: '已关闭' }).waitFor();
  await surface.getByRole('button', { name: '启动桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const reopened = browser.contexts()[0].pages()[0];
  await reopened.waitForSelector('#pet[data-character=whale]');
  assert.equal(await surface.locator('#coopanion-npcHome').inputValue(), '20');
  assert.equal(await surface.locator('#coopanion-npcRange').inputValue(), '25');
  await reopened.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--size') === '180px');
  await reopened.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-scale') === '1.5');
  await reopened.waitForFunction(() => document.querySelector('#companion-mode').value === 'off');
  await surface.getByRole('button', { name: '管理角色', exact: true }).click();
  await reopened.waitForSelector('#characters:not([hidden])');
  await surface.getByRole('switch', { name: '随 Harness 启动', exact: true }).click();
  await surface.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /autoStart: false/);
  await settings.screenshot({ path: join(project, 'artifacts', `settings-${version}.png`) });
  const lightColor = await surface.evaluate(element => getComputedStyle(element).color);
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  await settings.getByRole('button', { name: '深色', exact: true }).click();
  await settings.getByRole('button', { name: '桌宠', exact: true }).click();
  await settings.waitForFunction(color => getComputedStyle(document.querySelector('.dsh-coopanion-settings')).color !== color, lightColor);
  await settings.screenshot({ path: join(project, 'artifacts', `settings-dark-${version}.png`) });
  await settings.getByRole('button', { name: '通用设置', exact: true }).click();
  await settings.getByRole('button', { name: '中文', exact: true }).click();
  await settings.getByRole('menuitem', { name: 'English', exact: true }).click();
  await settings.getByRole('button', { name: 'Desktop pet', exact: true }).click();
  await surface.getByRole('heading', { name: 'Pet status', exact: true }).waitFor();
  await reopened.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await reopened.locator('#chat-title').textContent(), 'I’m here. Take your time.');
  assert.match(await reopened.locator('#menu-chat').textContent(), /Say something/);
  assert.equal(await reopened.locator('#menu-name').textContent(), 'DeepSeek Whale');
  assert.equal(await reopened.locator('#reader-close').getAttribute('aria-label'), 'Close full reply');
  await surface.getByRole('switch', { name: 'Start with Harness', exact: true }).waitFor();
  await surface.getByRole('button', { name: 'Manage characters', exact: true }).waitFor();
  assert.equal(await surface.getByRole('spinbutton', { name: 'Character size', exact: true }).inputValue(), '180');
  assert.equal(await surface.getByRole('combobox', { name: 'Text size', exact: true }).inputValue(), '1.5');
  assert.equal(await surface.getByRole('switch', { name: 'Daily rhythm', exact: true }).count(), 0);
  assert.equal(await surface.getByRole('combobox', { name: 'Companionship', exact: true }).inputValue(), 'off');
  await settings.screenshot({ path: join(project, 'artifacts', `settings-en-${version}.png`) });
  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await settings.getByRole('button', { name: 'English', exact: true }).click();
  await settings.getByRole('menuitem', { name: '中文', exact: true }).click();
  await settings.getByRole('button', { name: '桌宠', exact: true }).waitFor();
  await reopened.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.equal(await reopened.locator('#chat-title').textContent(), '我在，慢慢说。');
  assert.equal(await reopened.locator('#menu-name').textContent(), 'DeepSeek 大肥鱼');
  await waitProfile(/preference: zh/);
  await settings.getByRole('button', { name: '桌宠', exact: true }).click();
  await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).selectOption('interactive');
  await waitProfile(/companionship: interactive/);
  await stop(host); assert.equal(host.exitCode, 0, hostLog);
  await bootHost();
  await settings.goto(hostUrl);
  await openPetSettings(settings);
  await surface.getByTestId('pet-status').filter({ hasText: '已关闭' }).waitFor();
  assert.equal(await surface.getByRole('spinbutton', { name: '角色尺寸', exact: true }).inputValue(), '180');
  assert.equal(await surface.getByRole('combobox', { name: '文字大小', exact: true }).inputValue(), '1.5', 'full Host restart preserves text scale');
  assert.equal(await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).inputValue(), 'interactive', 'full Host restart preserves companionship');
  await surface.getByRole('combobox', { name: '自主陪伴', exact: true }).selectOption('off');
  await waitProfile(/companionship: off/); // Exercise recovery with autonomous activity disabled.
  assert.equal(await surface.getByRole('switch', { name: '随 Harness 启动', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await surface.getByRole('switch', { name: '系统通知', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await surface.getByRole('switch', { name: '待处理请求补提醒', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await surface.getByRole('spinbutton', { name: '补提醒等待时间', exact: true }).inputValue(), '1');
  await surface.getByRole('button', { name: '管理角色', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const afterHostRestart = browser.contexts()[0].pages()[0];
  await afterHostRestart.waitForSelector('#pet[data-character=whale]');
  await afterHostRestart.waitForSelector('#characters:not([hidden])');
  const oldWindowClosed = afterHostRestart.waitForEvent('close');
  await surface.getByRole('button', { name: '重启', exact: true }).click();
  await oldWindowClosed;
  await settings.waitForFunction(() => [...document.querySelectorAll('.dsh-coopanion-settings button')].find(button => button.textContent === '重启')?.disabled === false);
  await surface.getByTestId('pet-status').filter({ hasText: '正在显示' }).waitFor();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await browser.contexts()[0].pages()[0].waitForSelector('#pet[data-character=whale]');
  await browser.contexts()[0].pages()[0].waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-scale') === '1.5');
  await surface.getByRole('button', { name: '关闭桌宠', exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: '已关闭' }).waitFor();
  const languageReady = new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => finish(new Error('Automatic language selection timed out')), 15000);
    const receive = message => { if (message?.type === 'system-language-ready') finish(message.error ? new Error(message.error) : undefined); };
    function finish(error) { clearTimeout(timeout); host.off('message', receive); if (error) reject(error); else resolveReady(); }
    host.on('message', receive);
  });
  host.send({ type: 'follow-system-language' });
  await languageReady;
  assert.doesNotMatch(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /preference: (?:zh|en)\b/);
  for (const locale of ['en-US', 'zh-CN']) {
    const context = await settingsBrowser.newContext({ locale, viewport: { width: 1280, height: 900 } });
    try {
      const automatic = await context.newPage();
      automatic.on('pageerror', error => uiErrors.push(error.message));
      await automatic.goto(hostUrl);
      await openPetSettings(automatic, locale === 'zh-CN');
      const translated = automatic.getByTestId('coopanion-settings');
      await translated.getByRole('heading', { name: locale === 'zh-CN' ? '偏好设置' : 'Preferences', exact: true }).waitFor();
      await translated.getByRole('button', { name: locale === 'zh-CN' ? '启动桌宠' : 'Start pet', exact: true }).waitFor();
      const size = translated.getByRole('spinbutton', { name: locale === 'zh-CN' ? '角色尺寸' : 'Character size', exact: true });
      await size.fill('89'); await size.press('Tab');
      await translated.getByText(locale === 'zh-CN' ? '请输入范围内的数字。' : 'Enter a number within the allowed range.', { exact: true }).waitFor();
      assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /size: 180/, 'invalid localized inputs do not write preferences');
      await automatic.screenshot({ path: join(project, 'artifacts', `settings-system-${locale}-${version}.png`) });
    } finally { await context.close(); }
  }
  assert.deepEqual(uiErrors, [], 'the native DSH module loader and settings renderer have no page errors');
  const m2Command = (command, reply) => new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => { host.off('message', receive); reject(new Error(`M2 installed command timed out: ${command}`)); }, 10000);
    const receive = message => { if (message?.type !== reply) return; clearTimeout(timer); host.off('message', receive); message.error ? reject(new Error(message.error)) : resolveReply(message); };
    host.on('message', receive); host.send({ type: command });
  });
  assert.equal((await m2Command('prepare-m2-cold', 'm2-cold-ready')).cold, true);
  await surface.getByRole('button', { name: /^(启动桌宠|Start pet)$/, exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: /正在显示|Visible/ }).waitFor();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const m2Page = browser.contexts()[0].pages()[0];
  await m2Page.waitForSelector('#pet[data-character=whale][data-host-ready=true]');
  await openSessionPicker(m2Page); await m2Page.locator('#conversation-list [data-session-id="m2-installed-cold-full"]').click();
  await petClick(m2Page, {}, true);
  await m2Page.locator('#message').fill('M2 原生精确消息 🐳\n继续旧会话');
  await m2Page.locator('#send').click();
  await m2Page.evaluate(() => document.getElementById('chat-form').requestSubmit());
  await m2Page.waitForFunction(() => document.getElementById('chat-send-state').dataset.state === 'accepted');
  assert.equal(await m2Page.locator('#message').inputValue(), '');
  let m2Records = (await m2Command('read-m2-records', 'm2-records')).events;
  let m2Messages = [...new Map(m2Records.flatMap(e => e.type === 'agent/inbox/spliced' ? e.data.inserted : e.type === 'user/message' ? [e.data] : []).filter(m => m.source.kind === 'user' && m.source.rpcId).map(m => [m.id, m])).values()];
  assert.equal(m2Messages.length, 1, 'rapid native duplicate submit writes once');
  assert.deepEqual(m2Messages[0].content, [{ type: 'text', text: 'M2 原生精确消息 🐳\n继续旧会话' }]);
  assert.ok(m2Messages[0].source.rpcId); assert.ok(m2Messages[0].source.clientTimeZone);
  await m2Page.locator('#chat-close').click();
  await m2Page.waitForFunction(() => !document.getElementById('chat-read').hidden);
  await petClick(m2Page, {}, true); await m2Page.locator('#chat-read').click();
  await m2Page.waitForFunction(() => document.getElementById('reader-text').textContent === 'M2 installed full result 🐳');
  await m2Page.locator('#reader-session').click();
  assert.equal(await m2Page.locator('#chat').isVisible(), true);
  await m2Page.locator('#message').fill('M2 读完整结果后继续'); await m2Page.locator('#send').click();
  await m2Page.waitForFunction(() => document.getElementById('chat-send-state').dataset.state === 'accepted');
  m2Records = (await m2Command('read-m2-records', 'm2-records')).events;
  m2Messages = [...new Map(m2Records.flatMap(e => e.type === 'agent/inbox/spliced' ? e.data.inserted : e.type === 'user/message' ? [e.data] : []).filter(m => m.source.kind === 'user' && m.source.rpcId).map(m => [m.id, m])).values()];
  assert.equal(m2Messages.length, 2); assert.notEqual(m2Messages[0].source.rpcId, m2Messages[1].source.rpcId);
  await writeFile(join(project, 'artifacts', `session-native-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), sessionId: 'm2-installed-cold-full', cases: { cold: true, nativeRendererMainHostReceipt: true, rapidDuplicateOnce: true, exactPersistedIdentity: true, readFullResultAndContinue: true }, messages: m2Messages, events: m2Records }, null, 2) + '\n');
  // M3: crash the actual installed Electron main process while hidden. The
  // official Host stays alive and rehydrates its current state without input replay.
  const recoveryState = async () => {
    const response = await settings.request.post(new URL('/api/coopanion/notification-state', hostUrl).href, { headers: { Origin: new URL(hostUrl).origin }, data: { type: 'client-request', rpcId: 'm3-runtime', method: 'coopanion/notification-state', payload: {} } });
    assert.equal(response.status(), 200); const envelope = await response.json(); assert.equal(envelope.result.ok, true); return envelope.result.value;
  };
  const focusBeforeRecovery = await m2Page.locator('#chat-session-name').innerText();
  const actualApproval = await m2Command('prepare-m3-pending', 'm3-pending-ready');
  assert.equal(actualApproval.previousReplyPending, true, 'M3 waits for the accepted but unfinished M2 reply');
  const beforeRecovery = await recoveryState();
  assert.ok(beforeRecovery.interactions.some(item => item.nativeId === actualApproval.approvalId), 'an actual public approval request is pending before the crash');
  const messagesBeforeRecovery = m2Messages.map(message => message.id);
  const notificationCount = await settings.evaluate(() => window.__notificationInstall?.objects.length ?? 0);
  await m2Page.locator('#message').fill('M3 未发送的窗口草稿');
  await surface.getByRole('button', { name: /^(隐藏桌宠|Hide pet)$/, exact: true }).click();
  await waitRecovery(async () => { const state = await recoveryState(); return state.runtime.visible === false && state.runtime.desiredVisible === false; }, 'installed pet did not acknowledge hidden intent');
  const crashedPid = await crashNative(browser); browser = undefined;
  const recoveryStates = [];
  await waitRecovery(async () => {
    const state = await recoveryState(); recoveryStates.push(state.runtime);
    assert.equal(host.exitCode, null, 'Harness remains available during native recovery');
    return state.runtime.phase === 'running' && state.runtime.generation > beforeRecovery.runtime.generation && state.runtime.visibilityRevision > 0;
  }, 'installed hidden process did not recover');
  const afterRecovery = await recoveryState();
  assert.equal(afterRecovery.runtime.visible, false); assert.equal(afterRecovery.runtime.desiredVisible, false);
  assert.deepEqual(afterRecovery.interactions.map(item => [item.id, item.state]), beforeRecovery.interactions.map(item => [item.id, item.state]));
  browser = await connectRecovered(port);
  const recoveredPage = browser.contexts()[0].pages()[0];
  recoveredPage.on('pageerror', error => uiErrors.push(error.message));
  await recoveredPage.waitForSelector('#pet[data-host-ready=true]');
  assert.equal(await recoveredPage.locator('#bubble').isVisible(), false);
  assert.equal(await recoveredPage.locator('#message').inputValue(), '');
  await surface.getByRole('button', { name: /^(显示桌宠|Show pet)$/, exact: true }).click();
  await surface.getByTestId('pet-status').filter({ hasText: /正在显示|Visible/ }).waitFor();
  await petClick(recoveredPage, {}, true);
  assert.equal(await recoveredPage.locator('#chat-session-name').innerText(), focusBeforeRecovery);
  await recoveredPage.locator('#chat-read').click();
  await recoveredPage.waitForFunction(() => document.getElementById('reader-text').textContent === 'M2 installed full result 🐳');
  const recordsAfterRecovery = (await m2Command('read-m2-records', 'm2-records')).events;
  const messagesAfterRecovery = [...new Set(recordsAfterRecovery.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []).filter(message => message.source.kind === 'user' && message.source.rpcId).map(message => message.id))];
  assert.deepEqual(messagesAfterRecovery, messagesBeforeRecovery, 'native recovery does not resubmit M2 messages');
  assert.equal(await settings.evaluate(() => window.__notificationInstall?.objects.length ?? 0), notificationCount, 'old results do not generate new system notifications');
  await m2Command('cancel-m3-pending', 'm3-pending-cancelled');
  assert.equal((await recoveryState()).interactions.some(item => item.nativeId === actualApproval.approvalId), false, 'only the original service cancellation settles the request');
  await recoveredPage.keyboard.press('Escape');
  await writeFile(join(project, 'artifacts', `desktop-recovery-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), platform: process.platform, arch: process.arch, crashedPid, before: beforeRecovery, after: afterRecovery, observedRuntime: recoveryStates, persistedMessageIds: messagesAfterRecovery, cases: { actualInstalledProcessCrash: true, harnessAvailable: true, hiddenRecovery: true, fullResultAndFocus: true, validRequestsRetained: true, noChatReplay: true, noOldNotifications: true, rendererDraftLoss: true } }, null, 2) + '\n');
  const sourceResponse = await settings.request.post(new URL('/api/coopanion-notification-n0/probe', hostUrl).href, { headers: { Origin: new URL(hostUrl).origin }, data: { type: 'client-request', rpcId: 'n0-source', method: 'coopanion-notification-n0/probe', payload: { action: 'session' } } });
  assert.equal(sourceResponse.status(), 200, 'N0 public session creation is available');
  const sourceEnvelope = await sourceResponse.json(); assert.equal(sourceEnvelope.result.ok, true);
  const sourceId = sourceEnvelope.result.value.sessionId;
  const exportUrl = new URL('/api/session.export', hostUrl); exportUrl.searchParams.set('sessionId', sourceId); exportUrl.searchParams.set('includeDescendants', 'true');
  const exported = await settings.request.get(exportUrl.href); assert.equal(exported.status(), 200, 'N0 source is persistently exportable');
  const archiveFiles = unzipSync(await exported.body());
  const header = JSON.parse(Buffer.from(archiveFiles['session.v4.jsonl']).toString('utf8').split('\n')[0]);
  assert.equal(header.id, sourceId, 'the exported source retains the complete native session identity');
  await writeFile(join(project, 'artifacts', `notification-source-${version}.json`), JSON.stringify({ dsh: version, pluginVersion: manifest.version, creation: 'sessionController.create', sessionId: sourceId, exportedHeader: header, status: 'pass' }, null, 2) + '\n');
  await stop(host);
  assert.equal(host.exitCode, 0, hostLog);
  await writeFile(join(project, 'artifacts', `multi-display-installed-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), platform: process.platform, arch: process.arch, physicalMultiDisplay: false, physicalMixedDpi: false, samples: textScaleSamples.map(({ size, textScale, display }) => ({ size, textScale, ...display })) }, null, 2) + '\n');
  await writeFile(join(project, 'artifacts', `companionship-installed-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), platform: process.platform, arch: process.arch, defaultOff: true, removedRhythmIgnored: true, enumHotSync: true, draftSelectionAndFrame: true, nativeStoreIpc: p1Summary.writable, hostRestartPersistence: true, independentRuntime: false }, null, 2) + '\n');
  await writeFile(join(project, 'artifacts', `text-scale-installed-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), samples: textScaleSamples, oldConfigDefault: true, nativeRestart: true, hostRestart: true, englishLabel: true }, null, 2) + '\n');
  await writeFile(join(project, 'artifacts', `install-${version}.json`), JSON.stringify({ dsh: version, sourceCommit, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), m3NativeRecovery: true, m2NativeContinuation: true, plugin: `${manifest.name}@${manifest.version}`, package: archive, installed: true, profileLoader: true, nativeWindow: true, customCharacter: true, builtinCharacterId: 'whale', sessionNotifications: true, multipleSessions: true, roundReplyWithoutGoalCelebration: true, notificationOpensSourceSession: true, nativeSettingsPage: true, darkTheme: true, closeAndRelaunch: true, hostRestartPersistence: true, autoStartDisabled: true, chineseAndEnglish: true, liveLocaleSwitch: true, automaticSystemLanguage: true, riskExemption: false, cleanShutdown: true }, null, 2) + '\n');
  console.log(`Installation smoke passed on DSH ${version}: admission, actual profile loader, native window, independent sessions, session navigation from notices, official settings UI, live persisted preferences, and reopening after native close.`);
} catch (error) {
  if (browser) {
    const desktopPage = browser.contexts()[0]?.pages()[0];
    if (desktopPage) {
      await desktopPage.screenshot({ path: join(project, 'artifacts', `desktop-failed-${version}.png`) }).catch(() => {});
      console.error('Desktop diagnostic:', await desktopPage.locator('#character-status').innerText().catch(() => ''), await desktopPage.locator('#pet').getAttribute('data-character').catch(() => ''), uiErrors, consoleErrors.slice(0, 12));
    }
  }
  if (settingsPage) {
    await settingsPage.screenshot({ path: join(project, 'artifacts', `settings-failed-${version}.png`) }).catch(() => {});
    console.error('DSH frontend:', await settingsPage.locator('body').innerText().catch(() => ''), uiErrors, consoleErrors.slice(0, 8));
  }
  if (hostLog) console.error(hostLog);
  throw error;
} finally {
  await stop(host);
  if (browser) await browser.close();
  if (settingsBrowser) await settingsBrowser.close();
  await stop(display);
  await removeTree(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
