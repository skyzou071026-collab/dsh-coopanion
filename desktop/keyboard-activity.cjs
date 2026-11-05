const { spawn } = require('node:child_process');
const { join, win32 } = require('node:path');
const STATES = new Set(['active', 'idle', 'unknown']);
const BACKENDS = { darwin: 'macos', win32: 'windows', linux: 'x11' };
// Helpers reduce input to a bounded enum stream before it reaches Electron.
exports.createKeyboardActivity = ({ platform = process.platform, env = process.env, start = spawn, now = () => performance.now() } = {}) => {
  let child, value = 'unknown', at = -Infinity, pending = '', enabled = false, status = 'disabled', startedAt = 0;
  const backend = BACKENDS[platform] ?? 'none';
  const stop = reason => {
    const old = child; child = undefined; value = 'unknown'; at = -Infinity; pending = ''; status = reason; old?.kill();
  };
  function inspect() {
    if (child && status === 'starting' && now() - startedAt > 15000) stop('failed');
    const stale = ['available', 'unavailable'].includes(status) && now() - at > 2500;
    return { value: stale ? 'unknown' : value, backend, status: stale ? 'stale' : status };
  }
  return {
    configure(on) {
      if (!on) { enabled = false; stop('disabled'); return; }
      if (enabled) return; // No restart storm: disable/re-enable retries a failed helper.
      enabled = true;
      if (backend === 'none') { status = 'unsupported-platform'; return; }
      if (platform === 'linux' && (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || !env.DISPLAY)) { status = 'unsupported-session'; return; }
      let command, args;
      if (platform === 'darwin') { command = '/usr/bin/osascript'; args = ['-l', 'JavaScript', join(__dirname, 'keyboard-activity.jxa')]; }
      else if (platform === 'win32') {
        if (!env.SystemRoot || !win32.isAbsolute(env.SystemRoot)) { status = 'missing-dependency'; return; }
        command = win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const source = join(__dirname, 'keyboard-activity-win.cs').replace(/'/g, "''");
        args = ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$ErrorActionPreference='Stop'; try { Add-Type -Path '${source}' -ReferencedAssemblies System.Windows.Forms; [KeyboardActivity]::Run(${process.pid}) } catch { [Console]::Out.WriteLine('unknown'); exit 1 }`];
      } else { command = '/usr/bin/python3'; args = ['-I', '-u', join(__dirname, 'keyboard-activity-x11.py')]; }
      status = 'starting'; startedAt = now();
      let next;
      try { next = start(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
      catch (error) { stop(error.code === 'ENOENT' ? 'missing-dependency' : 'failed'); return; }
      child = next;
      next.stdout.on('data', bytes => {
        if (child !== next) return;
        pending += bytes.toString();
        if (pending.length > 256) { stop('protocol-error'); return; }
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
          if (!STATES.has(line)) { stop('protocol-error'); return; }
          value = line; at = now(); status = line === 'unknown' ? 'unavailable' : 'available';
        }
      });
      next.on('error', error => { if (child === next) stop(error.code === 'ENOENT' ? 'missing-dependency' : 'failed'); });
      next.on('exit', () => { if (child === next) stop('failed'); });
    },
    sample() { return inspect().value; },
    inspect,
  };
};
