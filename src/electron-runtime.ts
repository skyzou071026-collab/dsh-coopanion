import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { NativeStartError } from './desktop-lifecycle.ts';

// Electron 44's index.js may spawnSync its installer. Resolve files without
// executing that entrypoint, then prepare missing binaries off the Host loop.
export async function electronExecutable(signal: AbortSignal): Promise<string> {
  const directory = dirname(createRequire(import.meta.url).resolve('electron'));
  async function installed(): Promise<string | undefined> {
    let relative: string;
    try { relative = await readFile(join(directory, 'path.txt'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; relative = ''; }
    if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return join(process.env.ELECTRON_OVERRIDE_DIST_PATH, relative || 'electron');
    if (!relative) return;
    const executable = join(directory, 'dist', relative);
    try { await access(executable); return executable; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (signal.aborted) throw new Error('桌宠启动已取消');
  const existing = await installed();
  if (existing) return existing;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('桌宠启动已取消')); return; }
    const child = spawn(process.execPath, [join(directory, 'install.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true,
    });
    let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const aborted = () => stop(new Error('桌宠启动已取消'));
    const timer = setTimeout(() => stop(new NativeStartError('Electron 运行时准备超时，请检查网络或按使用指南预先安装运行时。', false)), 240_000);
    signal.addEventListener('abort', aborted, { once: true });
    const finish = (error?: Error) => {
      clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', aborted);
      if (failure || error) reject(failure ?? error); else resolve();
    };
    child.once('error', error => finish(new NativeStartError(error.message.slice(0, 600), false)));
    child.once('exit', code => finish(code === 0 ? undefined : new NativeStartError(`Electron 运行时准备失败 (${code})，请检查网络或按使用指南预先安装运行时。`, false)));
    if (signal.aborted) aborted();
  });
  if (signal.aborted) throw new Error('桌宠启动已取消');
  const executable = await installed();
  if (!executable) throw new NativeStartError('Electron 安装未生成可用运行时，请按使用指南重新准备。', false);
  return executable;
}
