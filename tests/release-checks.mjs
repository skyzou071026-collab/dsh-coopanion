import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { npmVersionState, packageName, releaseNotes } from '../scripts/release-support.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const validator = resolve(project, 'scripts/verify-release.mjs');

function candidate(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'coopanion-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(project, 'npm-shrinkwrap.json'), 'utf8'));
  const fixture = { pkg, lock, notes: `# v${pkg.version}\n\nCurrent changes.\n\n# v0.0.1\n\nOld changes.\n` };
  mutate(fixture);
  writeFileSync(join(root, 'package.json'), JSON.stringify(fixture.pkg));
  writeFileSync(join(root, 'npm-shrinkwrap.json'), JSON.stringify(fixture.lock));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/release-notes.md'), fixture.notes);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'release candidate']);
  const tag = `v${pkg.version}`;
  git(['tag', tag]);
  const verify = (args = []) => spawnSync(process.execPath, [validator, '--tag', tag, '--base', 'main', ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, tag, verify };
}

test('verifies a real stable tag and exports its immutable commit', t => {
  const fixture = candidate(t);
  const output = join(fixture.root, 'outputs');
  const result = spawnSync(process.execPath, [validator, '--tag', fixture.tag, '--base', 'main', '--github-output'], {
    cwd: fixture.root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), new RegExp(`commit=${fixture.git(['rev-parse', 'HEAD'])}\\n`));
});

test('rejects a prerelease tag instead of publishing it to latest', t => {
  const fixture = candidate(t);
  fixture.git(['tag', `${fixture.tag}-beta.1`]);
  const result = fixture.verify(['--tag', `${fixture.tag}-beta.1`]);
  assert.notEqual(result.status, 0);
});

test('rejects a tag whose package version differs', t => {
  const fixture = candidate(t);
  fixture.git(['tag', 'v99.0.0']);
  const result = fixture.verify(['--tag', 'v99.0.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag and package version differ/);
});

test('rejects a release outside main ancestry', t => {
  const fixture = candidate(t);
  fixture.git(['checkout', '-b', 'unmerged']);
  writeFileSync(join(fixture.root, 'unmerged'), 'not reviewed');
  fixture.git(['add', '.']);
  fixture.git(['commit', '-m', 'outside main']);
  fixture.git(['tag', '-f', fixture.tag]);
  assert.notEqual(fixture.verify().status, 0);
});

test('rejects a tag moved after candidate verification', t => {
  const fixture = candidate(t);
  const result = fixture.verify(['--commit', '0'.repeat(40)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag moved after verification/);
});

test('rejects shrinkwrap metadata and missing release notes', t => {
  const mismatch = candidate(t, ({ lock }) => { lock.packages[''].version = '99.0.0'; });
  assert.match(mismatch.verify().stderr, /shrinkwrap package version differs/);
  const missing = candidate(t, fixture => { fixture.notes = '# v0.0.1\n\nOld changes.\n'; });
  assert.match(missing.verify().stderr, /release notes missing/);
});

test('release notes contain only the target version and reject duplicates', () => {
  assert.equal(releaseNotes('# v2.0.0\n\nNew.\n\n# v1.0.0\n\nOld.\n', '2.0.0'), '# v2.0.0\n\nNew.\n');
  assert.throws(() => releaseNotes('# v1.0.0\n\nA.\n# v1.0.0\n\nB.', '1.0.0'), /duplicate/);
});

test('npm preflight distinguishes unused, identical, conflicting and unavailable versions', async () => {
  const integrity = 'sha512-tested-bytes';
  const request = (body, status = 200) => async url => {
    assert.equal(url, 'https://registry.npmjs.org/%40takboo%2Fdsh-coopanion/1.0.0');
    return new Response(JSON.stringify(body), { status });
  };
  assert.equal(await npmVersionState(packageName, '1.0.0', integrity, request({}, 404)), 'unpublished');
  assert.equal(await npmVersionState(packageName, '1.0.0', integrity, request({ name: packageName, version: '1.0.0', dist: { integrity } })), 'published');
  await assert.rejects(npmVersionState(packageName, '1.0.0', integrity, request({ name: packageName, version: '1.0.0', dist: { integrity: 'different' } })), /different bytes/);
  await assert.rejects(npmVersionState(packageName, '1.0.0', integrity, request({}, 503)), /HTTP 503/);
});

test('post-publish verification waits for the registry to expose identical bytes', async () => {
  const integrity = 'sha512-tested-bytes';
  let calls = 0;
  const request = async () => {
    calls += 1;
    return calls < 3
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ name: packageName, version: '1.0.0', dist: { integrity } }));
  };
  assert.equal(await npmVersionState(packageName, '1.0.0', integrity, request, { waitForPublished: true, pollMs: 0 }), 'published');
  assert.equal(calls, 3);
});

test('post-publish verification has a deadline and fails immediately on conflicts or registry errors', async () => {
  const integrity = 'sha512-tested-bytes';
  let calls = 0;
  const missing = async () => {
    calls += 1;
    return new Response('{}', { status: 404 });
  };
  await assert.rejects(npmVersionState(packageName, '1.0.0', integrity, missing, { waitForPublished: true, timeoutMs: 0 }), /npm has not published the verified bytes/);
  assert.equal(calls, 1);

  for (const [status, body, error] of [
    [200, { name: packageName, version: '1.0.0', dist: { integrity: 'different' } }, /different bytes/],
    [503, {}, /HTTP 503/],
  ]) {
    calls = 0;
    const request = async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status });
    };
    await assert.rejects(npmVersionState(packageName, '1.0.0', integrity, request, { waitForPublished: true, pollMs: 0 }), error);
    assert.equal(calls, 1);
  }
});
