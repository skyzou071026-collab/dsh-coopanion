import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

function macSample(down, up, permission = false) {
  const calls = [];
  const context = vm.createContext({ ObjC: { import() {}, bindFunction() {} }, $: {
    CGPreflightListenEventAccess: () => permission,
    CGEventSourceSecondsSinceLastEventType: (source, type) => { calls.push([source, type]); return type === 10 ? down : up; },
  } });
  vm.runInContext(readFileSync(new URL('../desktop/keyboard-activity.jxa', import.meta.url), 'utf8'), context);
  return { value: context.run(['--once']), calls };
}
it('macOS uses valid aggregate keyboard ages even when event-listening permission is absent', () => {
  expect(macSample(58, 58)).toEqual({ value: 'idle', calls: [[0, 10], [0, 11]] });
  expect(macSample(.1, .2).value).toBe('active');
});

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { createKeyboardActivity } = createRequire(import.meta.url)('../desktop/keyboard-activity.cjs');
function fixture(platform = 'darwin', env = {}) {
  let at = 0; const children = [], launches = [];
  const adapter = createKeyboardActivity({ platform, env, now: () => at, start(...args) {
    launches.push(args); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kills = 0;
    child.kill = () => { child.kills++; child.emit('exit'); }; children.push(child); return child;
  } });
  return { adapter, launches, children, time: t => { at = t; }, send: data => children.at(-1).stdout.emit('data', Buffer.from(data)) };
}
it('rejects invalid macOS ages, sentinels and API failure instead of claiming idle', () => {
  for (const age of [-1, Infinity, NaN, Number.MAX_VALUE, 1e10]) {
    expect(macSample(age, 0).value).toBe('unknown'); expect(macSample(0, age).value).toBe('unknown');
  }
  expect(macSample(0, 0).value).toBe('active'); expect(macSample(1.5, 1.5).value).toBe('idle');
});
it('selects native backends without a shell, PATH lookup or policy/permission changes', () => {
  for (const [platform, env, backend, command] of [
    ['darwin', {}, 'macos', '/usr/bin/osascript'],
    ['win32', { SystemRoot: 'C:\\Windows' }, 'windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    ['linux', { DISPLAY: ':99', XDG_SESSION_TYPE: 'x11' }, 'x11', '/usr/bin/python3'],
  ]) {
    const f = fixture(platform, env); f.adapter.configure(true); f.adapter.configure(true);
    expect(f.launches).toHaveLength(1); expect(f.launches[0][0]).toBe(command);
    expect(f.launches[0][2]).toEqual({ stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    expect(f.adapter.inspect()).toEqual({ value: 'unknown', backend, status: 'starting' });
    f.send(platform === 'win32' ? 'idle\r\n' : 'idle\n'); expect(f.adapter.inspect()).toEqual({ value: 'idle', backend, status: 'available' });
    f.adapter.configure(false); expect(f.children[0].kills).toBe(1);
  }
});
it('refuses Wayland/Xwayland and headless sessions; never falls back to mouse idle or key maps', () => {
  for (const env of [{}, { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, { DISPLAY: ':0', XDG_SESSION_TYPE: 'Wayland' }]) {
    const f = fixture('linux', env); f.adapter.configure(true);
    expect(f.adapter.inspect().status).toBe('unsupported-session'); expect(f.launches).toHaveLength(0);
  }
  const f = fixture('freebsd'); f.adapter.configure(true); expect(f.adapter.inspect().status).toBe('unsupported-platform');
  const w = fixture('win32'); w.adapter.configure(true); expect(w.adapter.inspect().status).toBe('missing-dependency');
});
it('bounds streams, stales safely, ignores retired children and does not restart failed processes in a poll loop', () => {
  const f = fixture(); expect(f.adapter.inspect().status).toBe('disabled'); f.adapter.configure(true);
  f.send('act'); expect(f.adapter.sample()).toBe('unknown'); f.send('ive\n'); expect(f.adapter.sample()).toBe('active');
  f.time(2501); expect(f.adapter.inspect()).toMatchObject({ value: 'unknown', status: 'stale' });
  f.send('idle\n'); expect(f.adapter.sample()).toBe('idle');
  f.adapter.configure(false); f.adapter.configure(true);
  f.children[0].stdout.emit('data', Buffer.from('active\n')); expect(f.adapter.sample()).toBe('unknown');
  f.children[0].emit('exit'); expect(f.adapter.inspect().status).toBe('starting');
  f.send('private key content\n'); expect(f.adapter.inspect()).toMatchObject({ value: 'unknown', status: 'protocol-error' });
  for (let i = 0; i < 100; i++) f.adapter.configure(true);
  expect(f.launches).toHaveLength(2); expect(f.children[1].kills).toBe(1);
  f.adapter.configure(false); f.adapter.configure(true); f.send('x'.repeat(257));
  expect(f.adapter.inspect().status).toBe('protocol-error');
});
it('handles missing executables, throws, exits and startup stalls without retaining active state', () => {
  for (const type of ['error', 'exit']) {
    const f = fixture(); f.adapter.configure(true); f.send('active\n');
    f.children[0].emit(type, Object.assign(Error(), { code: 'ENOENT' }));
    expect(f.adapter.inspect()).toMatchObject({ value: 'unknown', status: type === 'error' ? 'missing-dependency' : 'failed' });
  }
  const f = fixture(); f.adapter.configure(true); f.time(15001);
  expect(f.adapter.inspect()).toMatchObject({ value: 'unknown', status: 'failed' }); expect(f.children[0].kills).toBe(1);
  const adapter = createKeyboardActivity({ platform: 'darwin', start() { throw Error(); } });
  expect(() => adapter.configure(true)).not.toThrow(); expect(adapter.inspect().status).toBe('failed');
});

it('runs the actual macOS streaming loop through C output and stops when its parent exits', () => {
  let polls = 0; const output = [], sleeps = [];
  const context = vm.createContext({ ObjC: { import() {}, bindFunction() {} }, $: {
    getppid: () => ++polls < 4 ? 500 : 1,
    CGEventSourceSecondsSinceLastEventType: () => 58,
    puts: value => output.push(value), fflush() {}, usleep: value => sleeps.push(value),
  } });
  vm.runInContext(readFileSync(new URL('../desktop/keyboard-activity.jxa', import.meta.url), 'utf8'), context);
  context.run([]);
  expect(output).toEqual(['idle', 'idle']); expect(sleeps).toEqual([500000, 500000]);
});

it('accepts split Windows CRLF heartbeats and stales unknown heartbeats as well', () => {
  const f = fixture('win32', { SystemRoot: 'C:\\Windows' }); f.adapter.configure(true);
  f.send('active\r'); expect(f.adapter.sample()).toBe('unknown');
  f.send('\n'); expect(f.adapter.sample()).toBe('active');
  f.send('unknown\r\n'); expect(f.adapter.inspect().status).toBe('unavailable');
  f.time(2501); expect(f.adapter.inspect()).toMatchObject({ value: 'unknown', status: 'stale' });
});
