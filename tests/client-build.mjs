import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));

test('activates the built Client factory using only DSH public peers and React seeds', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: project, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const seeds = [...Object.keys(manifest.peerDependencies), 'react', 'react-dom'];
  let registration;
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    URL, TextEncoder, TextDecoder,
  });
  assert.equal(registration.id, manifest.name);
  const dependencies = [];
  const client = registration.factory(name => {
    dependencies.push(name);
    assert.ok(seeds.some(seed => name === seed || name.startsWith(`${seed}/`)), `Client requires an unregistered runtime module: ${name}`);
    return {};
  });
  assert.equal(typeof client.apply, 'function');
  assert.ok(dependencies.includes('react'));
});
