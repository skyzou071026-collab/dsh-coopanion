import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subprocessStatus } from './common.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const commit = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
export function sourceFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(p => p && !p.startsWith('docs/evidence/') && !p.startsWith('docs/archive/'));
}
export async function sourceDigest() {
  const hash = createHash('sha256');
  for (const path of sourceFiles().sort()) { hash.update(path + '\0'); hash.update(await readFile(join(root, path))); }
  return hash.digest('hex');
}
export async function copySource(workspace) {
  for (const path of sourceFiles()) { await mkdir(dirname(join(workspace, path)), { recursive: true }); await cp(join(root, path), join(workspace, path)); }
}
export async function isolatedEnv(scratch) {
  const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY|^DSH_|^COOPANION_|^NODE_OPTIONS$|^SSH_AUTH_SOCK$|^ELECTRON_/i.test(key)) delete env[key];
  const home = join(scratch, 'home'); await mkdir(home, { recursive: true });
  const config = join(scratch, 'empty.npmrc'); await writeFile(config, '');
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: join(scratch, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'),
    npm_config_registry: 'https://registry.npmjs.org', npm_config_userconfig: config, npm_config_globalconfig: join(scratch, 'global.npmrc') });
  await writeFile(env.npm_config_globalconfig, '');
  return env;
}
export class StageError extends Error { constructor(name, status) { super(`${name}: ${status}`); this.status = status; } }
export async function command(report, output, name, file, args, { cwd = root, env = process.env, setup = false, captureStdout = false, timeout = 15 * 60000 } = {}) {
  await mkdir(output, { recursive: true });
  let log = '', stdout = '', timedOut = false, error;
  const result = await new Promise(done => {
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = signal => {
      try {
        if (process.platform === 'win32') { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); killer.on('error', () => child.kill(signal)); }
        else process.kill(-child.pid, signal);
      } catch (e) { if (e.code !== 'ESRCH') error ??= e; }
    };
    let force;
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 10000); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { if (log.length < 12 * 1024 * 1024) log += data; if (captureStdout && stream === child.stdout && stdout.length < 12 * 1024 * 1024) stdout += data; });
    child.once('error', e => { error = e; });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); done({ code, signal }); });
  });
  log = log.replace(/(token|password|authorization)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]');
  await writeFile(join(output, name + '.log'), log);
  const status = subprocessStatus({ ...result, error, timedOut, setup, log });
  report.stages.push({ name, status, exitCode: result.code, signal: result.signal, timedOut });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${name}: ${status}`);
  if (status !== 'passed') { console.error(log.slice(-6000)); throw new StageError(name, status); }
  return captureStdout ? stdout : log;
}
export const npmCli = () => { if (!process.env.npm_execpath) throw new Error('Run through npm run compat:<command>'); return process.env.npm_execpath; };
