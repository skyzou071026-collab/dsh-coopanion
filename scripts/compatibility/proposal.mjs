import assert from 'node:assert/strict';
import { version, compareVersions } from './common.mjs';
import { verifyMetadata } from '../release-support.mjs';
export function targetManifest(baseline, target) {
  version(target);
  const supported = baseline.engines.dsh.split(' || ');
  assert(compareVersions(target, supported.toSorted(compareVersions).at(-1)) >= 0, 'No candidate downgrade');
  const result = structuredClone(baseline);
  result.engines.dsh = [...new Set([...supported, target])].join(' || ');
  for (const name of Object.keys(result.peerDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) {
    result.peerDependencies[name] = [...new Set([...result.peerDependencies[name].split(' || '), target])].join(' || ');
  }
  for (const name of Object.keys(result.devDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) result.devDependencies[name] = target;
  return result;
}
export function validateProposal(proposal, baseline, target, sourceCommit) {
  assert.equal(proposal.version, version(target)); assert.equal(proposal.sourceCommit, sourceCommit);
  assert.deepEqual(Object.keys(proposal.files).sort(), ['npm-shrinkwrap.json', 'package.json']);
  for (const content of Object.values(proposal.files)) assert(typeof content === 'string' && Buffer.byteLength(content) < 4 * 1024 * 1024);
  const pkg = JSON.parse(proposal.files['package.json']), lock = JSON.parse(proposal.files['npm-shrinkwrap.json']);
  assert.deepEqual(pkg, targetManifest(baseline, target)); verifyMetadata(pkg, lock);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert(entry.resolved && new URL(entry.resolved).origin === 'https://registry.npmjs.org', 'Only registry packages allowed');
    assert(/^sha512-[A-Za-z\d+/]+=*$/.test(entry.integrity), 'Locked package needs integrity');
    if (/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[\w-]+)?$/.test(path)) assert.equal(entry.version, target);
  }
  return proposal.files;
}

// Drop only stale Host resolutions. Keep every unrelated locked dependency intact.
export function candidateLock(lock, manifest) {
  const next = structuredClone(lock); next.version = manifest.version;
  for (const field of ['version', 'engines', 'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta']) next.packages[''][field] = manifest[field];
  for (const path of Object.keys(next.packages)) if (path.includes('node_modules/@deepseek-ai/')) delete next.packages[path];
  return next;
}
