import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { git, npmTarballName, readJson, releaseNotes, verifyMetadata } from './release-support.mjs';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'write-report': { type: 'boolean', default: false },
  report: { type: 'string' },
  'expected-commit': { type: 'string' },
  'expected-version': { type: 'string' },
} });
assert.ok(positionals.length <= 1, 'pass at most one tarball');
assert.ok(!(values['write-report'] && values.report), 'write or verify a report, not both');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const archive = positionals[0] ?? npmTarballName(pkg);
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'invalid archive paths');
const unpack = path => execFileSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8' });
const packed = JSON.parse(unpack('package.json'));
verifyMetadata(packed, JSON.parse(unpack('npm-shrinkwrap.json')));
assert.ok(unpack('cordis.patch.yml').includes(`name: '${packed.name}'`), 'bundle must load the scoped package');
assert.ok(unpack('dist/client.js').includes(`id: ${JSON.stringify(packed.name)}`), 'browser module must register the scoped package');
if (values['expected-version']) assert.equal(packed.version, values['expected-version'], 'archive version differs from tag');
else assert.equal(packed.version, pkg.version);
assert.equal(packed.repository.url, pkg.repository.url);
for (const required of ['dist/client.js', 'dist/index.js', 'dist/character-store.cjs', 'dist/figure-server.cjs', 'cordis.patch.yml', 'desktop/main.cjs', 'desktop/tray-state.cjs', 'desktop/preload.cjs', 'web/index.html', 'web/pet.js', 'web/speech.js', 'web/session-ui.js', 'web/chat-contract.js', 'web/chat-contract.d.ts', 'web/text-scale.js', 'web/text-scale.d.ts', 'docs/text-readability-contract.md', 'tests/text-scale-ui.mjs', 'tests/helpers/text-scale-native.mjs', 'src/chat.ts', 'tests/session-host-contract.mjs', 'tests/fixtures/session-host.mjs', 'docs/session-chat-contract.md', 'web/locale.js', 'web/locale.d.ts', 'src/client/locale-sync.ts', 'tests/locale-ui.mjs', 'tests/locale-client.mjs', 'web/reply-markdown.js', 'web/markdown-runtime.js', 'web/tray-icon.js', 'web/upstream/kit/rig.js', 'web/upstream/kit/body.js', 'web/upstream/figure-frame.html', 'web/upstream/body-host.js', 'web/upstream/whale/figure.json', 'web/upstream/whale/model.json', 'web/upstream/whale/tex/face.png', 'web/upstream/UPSTREAM.md', 'web/upstream/THIRD_PARTY_NOTICES.md', 'src/figure-server.ts', 'src/upstream/packs.ts', 'scripts/build.mjs', 'npm-shrinkwrap.json', 'tsconfig.json', 'tsconfig.client.json', '.node-version', 'docs/characters.md', 'examples/star/figure.json', 'examples/star/figure.js', 'tests/figures.test.ts', 'docs/licenses/marked.txt', 'docs/licenses/dompurify.txt', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'LICENSE-MIT', 'README.md']) assert.ok(entries.includes(`package/${required}`), `missing ${required}`);
assert.ok(!entries.some(path => path.includes('node_modules/') || path.includes('.cache/')));
assert.ok(!entries.some(path => /character-runtime|character.schema|\/animation\.|\/character-pack\.(?:[cm]?[jt]s)(?:\.map)?$|\/web\/characters\//.test(path)), 'old engine and format must not be packaged');
assert.ok(!entries.some(path => /^package\/(?:web\/daily-rhythm\.|tests\/(?:daily-rhythm[.-]|helpers\/daily-rhythm\.))/.test(path)), 'removed idle schedulers must not be packaged');
assert.ok(!entries.some(path => /^package\/docs\/(?:archive|evidence)\//.test(path)), 'historical evidence and handoff plans must not be packaged');
const bytes = readFileSync(archive);
for (const required of ['src/desktop-lifecycle.ts', 'src/controls.ts', 'docs/desktop-recovery-contract.md', 'tests/fixtures/desktop-recovery.ts', 'tests/helpers/desktop-recovery.mjs']) assert.ok(entries.includes(`package/${required}`), `missing recovery source ${required}`);
for (const required of ['web/display-geometry.js', 'desktop/display-controller.cjs', 'desktop/test-display-probe.cjs', 'docs/multi-display-contract.md', 'tests/display-geometry.test.js', 'tests/multi-display-ui.mjs', 'tests/multi-display-native.mjs', 'tests/helpers/multi-display-native.mjs']) assert.ok(entries.includes(`package/${required}`), `missing geometry source ${required}`);
for (const required of ['tests/attention-size-ui.mjs', 'tests/npc-drag-ui.mjs', 'tests/npc-controls-ui.mjs', 'tests/helpers/body-orders.mjs', 'scripts/measure-idle.mjs']) assert.ok(entries.includes(`package/${required}`), `missing NPC controls source ${required}`);
for (const required of ['dist/companion-store.cjs', 'src/companion-store.ts', 'web/companionship.js', 'web/companionship.d.ts', 'web/companion-client.js', 'web/companion-touch.js', 'docs/companionship-contract.md', 'tests/companionship.test.js', 'tests/companion-store.test.ts', 'tests/companion-client.test.js', 'tests/companion-touch.test.js', 'tests/companion-http.test.ts', 'tests/companionship-ui.mjs', 'tests/companionship-native.mjs', 'tests/helpers/companionship.mjs']) assert.ok(entries.includes(`package/${required}`), `missing companionship source ${required}`);
for (const required of ['web/npc-life.js', 'desktop/keyboard-activity.cjs', 'desktop/keyboard-activity.jxa', 'desktop/keyboard-activity-win.cs', 'desktop/keyboard-activity-x11.py', 'tests/keyboard-activity.test.js', 'tests/keyboard-activity-native.mjs', 'tests/helpers/keyboard-x11-probe.py', 'tests/npc-life.test.js', 'tests/npc-life-native.mjs', 'tests/helpers/npc-life.mjs']) assert.ok(entries.includes('package/' + required), 'missing NPC source ' + required);
for (const required of ['desktop/lifecycle-state.cjs', 'desktop/lifecycle-state-macos.jxa', 'tests/lifecycle-state.test.js', 'tests/lifecycle-startup-native.mjs', 'dist/diagnostics.cjs', 'dist/build-info.json', 'src/diagnostics.ts', 'web/diagnostics.js', 'web/render-cadence.js', 'scripts/sample-companion.mjs', 'scripts/diagnostics-client.mjs', 'scripts/resource-observation.mjs', 'docs/diagnostics-contract.md', 'tests/diagnostics.test.js', 'tests/diagnostics-native.mjs']) assert.ok(entries.includes('package/' + required), 'missing diagnostics source ' + required);
const buildInfo = JSON.parse(unpack('dist/build-info.json'));
assert.equal(buildInfo.schema, 1);
assert.match(buildInfo.productDigest, /^[a-f0-9]{64}$/);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const notes = releaseNotes(unpack('docs/release-notes.md'), packed.version);
if (values['write-report']) {
  assert.equal(git(['status', '--porcelain']), '', 'release report requires a clean committed checkout');
  const sourceCommit = git(['rev-parse', 'HEAD']);
  assert.equal(buildInfo.commit, sourceCommit, 'build metadata must bind the packaged candidate commit');
  assert.equal(buildInfo.dirty, false, 'candidate report requires a committed build');
  if (values['expected-commit']) assert.equal(sourceCommit, values['expected-commit']);
  const report = { name: packed.name, version: packed.version, sourceCommit, sha256, integrity };
  writeFileSync(join(dirname(archive), 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dirname(archive), 'release-notes.md'), notes);
}
if (values.report) {
  const report = readJson(values.report);
  assert.ok(values['expected-commit'], '--report requires --expected-commit');
  assert.equal(report.sourceCommit, values['expected-commit'], 'artifact source differs from verified commit');
  assert.equal(report.name, packed.name);
  assert.equal(report.version, packed.version);
  assert.equal(report.sha256, sha256, 'archive SHA-256 differs from verified report');
  assert.equal(report.integrity, integrity, 'archive integrity differs from verified report');
  assert.equal(readFileSync(join(dirname(values.report), 'release-notes.md'), 'utf8'), notes);
}
console.log(`Package verified: ${entries.length} files, upstream runtime, native host and corresponding source included. SHA-256: ${sha256}`);
