import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { git, releaseNotes, stableVersion, verifyMetadata } from './release-support.mjs';

const { values } = parseArgs({ options: {
  tag: { type: 'string' },
  base: { type: 'string', default: 'origin/main' },
  commit: { type: 'string' },
  'github-output': { type: 'boolean', default: false },
} });
assert.ok(values.tag?.startsWith('v') && stableVersion.test(values.tag.slice(1)), 'tag must be stable v<major>.<minor>.<patch>');
assert.match(values.base, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid base ref');
const commit = git(['rev-parse', '--verify', `refs/tags/${values.tag}^{commit}`]);
git(['merge-base', '--is-ancestor', commit, values.base]);
if (values.commit) assert.equal(commit, values.commit, 'tag moved after verification');
const pkg = JSON.parse(git(['show', `${commit}:package.json`]));
verifyMetadata(pkg, JSON.parse(git(['show', `${commit}:npm-shrinkwrap.json`])));
assert.equal(values.tag, `v${pkg.version}`, 'tag and package version differ');
releaseNotes(git(['show', `${commit}:docs/release-notes.md`]), pkg.version);
if (values['github-output']) {
  assert.ok(process.env.GITHUB_OUTPUT, '--github-output requires GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\nversion=${pkg.version}\ntag=${values.tag}\n`);
}
console.log(`Release verified: ${values.tag} at ${commit}, reachable from ${values.base}`);
