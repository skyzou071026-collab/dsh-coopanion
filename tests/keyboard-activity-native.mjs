import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(process.env.DSH_NPC_PACKAGE_ROOT ?? '.');
const { createKeyboardActivity } = createRequire(import.meta.url)(resolve(root, 'desktop/keyboard-activity.cjs'));
const adapter = createKeyboardActivity();
const counts = { active: 0, idle: 0, unknown: 0 };
const statuses = new Set();
try {
  adapter.configure(true);
  const began = performance.now(), until = began + 20000;
  while (performance.now() < until) {
    const observation = adapter.inspect();
    assert.ok(Object.hasOwn(counts, observation.value)); counts[observation.value]++; statuses.add(observation.status);
    assert.ok(!['failed', 'protocol-error', 'missing-dependency'].includes(observation.status), `Native keyboard helper: ${observation.status}`);
    if (performance.now() - began >= 10000 && observation.status !== 'starting') break;
    await new Promise(r => setTimeout(r, 500));
  }
  const observation = adapter.inspect();
  assert.notEqual(observation.status, 'starting');
  assert.ok(!['failed', 'protocol-error', 'missing-dependency'].includes(observation.status));
  if (process.platform === 'darwin' || (process.platform === 'linux' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland')) {
    assert.ok(counts.active + counts.idle > 0, 'Expected usable native aggregate/category backend');
  }
  const syntheticX11 = process.platform === 'linux' && observation.backend === 'x11' && process.env.DSH_KEYBOARD_TEST_X11_INPUT === '1'
    ? JSON.parse(execFileSync('/usr/bin/python3', ['-I', resolve(root, 'tests/helpers/keyboard-x11-probe.py'), resolve(root, 'desktop/keyboard-activity-x11.py')], { encoding: 'utf8', timeout: 15000 })) : null;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/keyboard-activity-native.json', JSON.stringify({
    build: JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')),
    platform: process.platform, arch: process.arch, backend: observation.backend,
    statuses: [...statuses], samples: counts,
    physicalTypingValidated: false, syntheticX11,
    // A service/remote Windows session may intentionally remain unknown.
    usable: counts.active + counts.idle > 0,
  }, null, 2) + '\n');
  console.log('Native keyboard helper startup, enum protocol and cleanup verified:', observation.backend, [...statuses].join(','));
} finally { adapter.configure(false); }
assert.equal(adapter.inspect().status, 'disabled');
