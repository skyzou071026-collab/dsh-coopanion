import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const repository = 'takboo/dsh-coopanion';
export const packageName = '@takboo/dsh-coopanion';
export const npmTarballName = pkg => `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();

export function verifyMetadata(pkg, lock) {
  assert.equal(pkg.name, packageName);
  assert.match(pkg.version, stableVersion, 'releases use stable SemVer versions');
  assert.equal(pkg.repository?.url, `git+https://github.com/${repository}.git`);
  assert.equal(pkg.license, 'AGPL-3.0-or-later');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org');
  assert.equal(pkg.packageManager, 'npm@11.19.1');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.exports?.['.'], './dist/index.js');
  assert.equal(pkg.exports?.['./client'], './dist/client.js');
  assert.equal(lock.lockfileVersion, 3);
  for (const root of [lock, lock.packages?.['']]) {
    assert.equal(root?.name, pkg.name, 'shrinkwrap package name differs');
    assert.equal(root?.version, pkg.version, 'shrinkwrap package version differs');
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'license']) {
    assert.deepEqual(lock.packages[''][field], pkg[field], `shrinkwrap ${field} differs`);
  }
  assert.ok(!Object.keys(pkg.dependencies).some(name => name.startsWith('@deepseek-ai/')), 'host packages must remain peers');
}

export function releaseNotes(notes, version) {
  const sections = [...notes.matchAll(/^# v([^\s]+)\s*$/gm)];
  const section = sections.findIndex(match => match[1] === version);
  assert.ok(section >= 0, `release notes missing v${version}`);
  assert.equal(sections.filter(match => match[1] === version).length, 1, 'duplicate release notes');
  const start = sections[section].index;
  const end = sections[section + 1]?.index ?? notes.length;
  const content = notes.slice(start + sections[section][0].length, end).trim();
  assert.ok(content.length > 0, 'release notes must describe this version');
  return `# v${version}\n\n${content}\n`;
}

export async function npmVersionState(name, version, integrity, request = fetch, { waitForPublished = false, timeoutMs = 5 * 60_000, pollMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const requestTimeout = waitForPublished ? Math.max(1, Math.min(15_000, deadline - Date.now())) : 15_000;
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(requestTimeout) });
    if (response.status === 404) {
      if (!waitForPublished) return 'unpublished';
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, `npm has not published the verified bytes within ${timeoutMs} ms`);
      await delay(Math.min(pollMs, remaining));
      continue;
    }
    assert.ok(response.ok, `npm registry lookup failed: HTTP ${response.status}`);
    const published = await response.json();
    assert.equal(published.name, name, 'registry returned a different package');
    assert.equal(published.version, version, 'registry returned a different version');
    assert.equal(published.dist?.integrity, integrity, 'npm version is occupied by different bytes; choose a new version');
    return 'published';
  }
}
