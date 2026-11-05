import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, subprocessStatus, digest, marker, compareVersions, assertRepository } from '../scripts/compatibility/common.mjs';
import { componentIdentities, componentDue, selectChecks, plannedComponents } from '../scripts/compatibility/planning.mjs';
import { combineTargets, parseDesktopFeed } from '../scripts/compatibility/discover.mjs';
import { completedComponents, overallStatus, validateReport, applyPreparationFailure } from '../scripts/compatibility/report.mjs';
import { targetManifest, candidateLock, validateProposal } from '../scripts/compatibility/proposal.mjs';
import { command, StageError, isolatedEnv } from '../scripts/compatibility/runner.mjs';
import { validateArchivePaths, validateSignature, validateDesktopRuntime } from '../scripts/compatibility/desktop-artifact.mjs';
const baseline = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
const sourceCommit = 'a'.repeat(40), version = `${Number(baseline.engines.dsh.split(' || ').toSorted(compareVersions).at(-1).split('.')[0]) + 1}.0.0-rc.6`;
const target = { version, identity: 'b'.repeat(64), npm: { integrity: 'sha512-test', publishedAt: '2026-11-01T00:00:00Z' }, channels: ['npm:next'], runSdk: true, runDesktop: false };
const completed = { identity: componentIdentities(target).sdk, status: 'partial', attempts: 1, run: '123', sourceCommit, updatedAt: '2026-11-01T00:00:00Z' };
const issue = components => ({ number: 5, user: { login: 'github-actions[bot]' }, updated_at: '2026-11-01T00:00:00Z', body: `<!-- dsh-compat-v2:${JSON.stringify({ version, identity: target.identity, attempts: 1, status: 'partial', components })} -->` });

test('SemVer prereleases sort numerically, then stable', () => {
  assert(compareVersions('0.2.1-rc.10', '0.2.1-rc.5') > 0); assert(compareVersions('0.2.1', '0.2.1-rc.10') > 0);
  assert.throws(() => compareVersions('0.2.1-rc.01', version));
});
test('completed component is skipped; a new npm identity is due', () => {
  assert.equal(selectChecks([target], [issue({ sdk: completed })], { baseline: '0.2.1-rc.5' }).length, 0);
  assert.equal(selectChecks([{ ...target, npm: { integrity: 'new' } }], [issue({ sdk: completed })], { baseline: '0.2.1-rc.5' })[0].runSdk, true);
});
test('a late Desktop publication only schedules Desktop and keeps SDK evidence', () => {
  const t = { ...target, desktop: { version, sha512: 'new', path: 'new' }, identity: 'c'.repeat(64) };
  const selected = selectChecks([t], [issue({ sdk: completed })], { baseline: '0.2.1-rc.5' })[0];
  assert.equal(selected.runSdk, false); assert.equal(selected.runDesktop, true);
  const next = plannedComponents(selected, { sdk: completed }, { run: '124', sourceCommit }); assert.deepEqual(next.sdk, completed);
});
test('release-only metadata update does not rerun completed SDK', () => {
  const selected = selectChecks([{ ...target, identity: 'c'.repeat(64) }], [issue({ sdk: completed })], { baseline: '0.2.1-rc.5' })[0];
  assert(selected.metadataOnly); assert.equal(selected.runSdk, false);
});
test('retry and interrupted running states have a six-hour interval and three-attempt ceiling', () => {
  const now = Date.parse('2026-11-01T07:00:00Z');
  for (const status of ['retry','running']) {
    assert(componentDue({ ...completed, status }, completed.identity, { now }));
    assert.equal(componentDue({ ...completed, status, attempts: 3 }, completed.identity, { now }), false);
    assert.equal(componentDue({ ...completed, status }, completed.identity, { now: now - 2 * 3600000 }), false);
  }
  assert.equal(componentDue({ ...completed, status: 'failed' }, completed.identity, { now }), false);
  assert(componentDue({ ...completed, attempts: 3 }, completed.identity, { manual: true }));
});
test('untrusted Issue state does not suppress checks and selection is bounded', () => {
  assert.equal(selectChecks([target], [{ ...issue({ sdk: completed }), user: { login: 'untrusted' } }], { baseline: '0.2.1-rc.5' }).length, 1);
  assert.equal(selectChecks(Array.from({ length: 5 }, (_, i) => ({ ...target, version: `0.2.1-rc.${6+i}` })), [], { baseline: '0.2.1-rc.5' }).length, 3);
  assert.equal(marker('<!-- dsh-compat-v2:{"version":"invalid"} -->'), undefined);
});
test('incomplete evidence and interrupted subprocesses stay retryable, including mixed failures', () => {
  assert.equal(aggregate([{ status: 'failed' }], 3), 'retry');
  assert.equal(aggregate([{ status: 'failed' }, { status: 'retry' }], 2), 'retry');
  assert.equal(aggregate([{ status: 'failed' }, { status: 'partial' }], 2), 'failed');
  for (const result of [{ code: null, timedOut: true }, { code: null, signal: 'SIGTERM' }, { error: new Error('ENOENT') }]) assert.equal(subprocessStatus(result), 'retry');
  assert.equal(subprocessStatus({ code: 1, log: 'ERESOLVE', setup: true }), 'failed');
  assert.equal(subprocessStatus({ code: 1, log: 'EAI_AGAIN' }), 'retry');
});
test('real timeout and missing executable are recorded as retry, assertion failure as failed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-monitor-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, file, args, status, timeout] of [
    ['timeout', process.execPath, ['-e', 'setInterval(()=>{},1000)'], 'retry', 50],
    ['missing', join(directory, 'missing'), [], 'retry', 1000],
    ['assertion', process.execPath, ['-e', 'process.exit(1)'], 'failed', 1000],
  ]) {
    const report = { stages: [] };
    await assert.rejects(command(report, directory, name, file, args, { timeout }), e => e instanceof StageError && e.status === status);
    assert.equal(report.stages[0].status, status);
  }
});
test('candidate manifest changes exact Host versions only and retains prior support', () => {
  const candidate = targetManifest(baseline, version);
  assert(candidate.engines.dsh.endsWith(version)); assert(candidate.engines.dsh.includes('0.2.1-rc.3'));
  assert.deepEqual(candidate.dependencies, baseline.dependencies); assert.equal(candidate.version, baseline.version);
  assert.equal(candidate.devDependencies['@deepseek-ai/cordis'], baseline.devDependencies['@deepseek-ai/cordis']);
  assert.throws(() => targetManifest(baseline, '0.2.0-rc.1'), /downgrade/);
});
test('lock refresh preserves unrelated exact resolutions', () => {
  const next = candidateLock(lock, targetManifest(baseline, version));
  assert.deepEqual(next.packages['node_modules/electron'], lock.packages['node_modules/electron']);
  assert(!Object.keys(next.packages).some(p => p.includes('node_modules/@deepseek-ai/')));
});
test('dependency proposal rejects source edits, version changes and untrusted registry resolutions', () => {
  // Current baseline is a valid manual rehearsal proposal.
  const current = baseline.engines.dsh.split(' || ').at(-1);
  const proposal = { version: current, sourceCommit, files: { 'package.json': JSON.stringify(baseline), 'npm-shrinkwrap.json': JSON.stringify(lock) } };
  validateProposal(proposal, baseline, current, sourceCommit);
  assert.throws(() => validateProposal({ ...proposal, files: { ...proposal.files, 'src/index.ts': 'bad' } }, baseline, current, sourceCommit));
  const changed = structuredClone(proposal); const pkg = JSON.parse(changed.files['package.json']); pkg.version = '9.9.9'; changed.files['package.json'] = JSON.stringify(pkg);
  assert.throws(() => validateProposal(changed, baseline, current, sourceCommit));
  const evil = structuredClone(lock); evil.packages['node_modules/electron'].resolved = 'https://evil.invalid/runtime.tgz';
  assert.throws(() => validateProposal({ ...proposal, files: { ...proposal.files, 'npm-shrinkwrap.json': JSON.stringify(evil) } }, baseline, current, sourceCommit));
});
test('report rejects missing stages and mismatched source or target identity', () => {
  const r = { version, sourceCommit, target, productionAdmissionChanged: false, productionSourcesStable: true, platform: 'linux', arch: 'x64', status: 'partial', archiveSha256: 'd'.repeat(64), stages: [] };
  assert.throws(() => validateReport(r, target, sourceCommit, 'sdk'), /Missing/);
  r.stages = ['host-install','normal-admission','candidate-installation'].map(name => ({ name, status: 'passed' })); validateReport(r, target, sourceCommit, 'sdk');
  assert.throws(() => validateReport({ ...r, sourceCommit: 'e'.repeat(40) }, target, sourceCommit, 'sdk'));
});
test('completed SDK requires all three platforms and never grants formal compatibility', () => {
  const reports = ['linux/x64','darwin/arm64','win32/x64'].map(value => { const [platform,arch] = value.split('/'); return { platform,arch,status:'partial' }; });
  const c = completedComponents(target, reports, {}, { run: '123', sourceCommit }); assert.equal(c.sdk.status, 'partial'); assert.equal(overallStatus(c, false), 'partial');
  assert.equal(completedComponents(target, reports.slice(1), {}, { run: '123', sourceCommit }).sdk.status, 'retry');
});
test('upstream channels coalesce and retain not-yet-published npm evidence', () => {
  const registry = { 'dist-tags': { latest: version, next: version }, versions: { [version]: { dist: { integrity: 'sha512-a', tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` } } }, time: { [version]: '2026-11-01' } };
  const release = { draft: false, published_at: '2026-11-01', tag_name: 'dsh-v'+version, id: 1 };
  const desktop = { version: '0.2.1-rc.7', sha512: 'pending', path: 'pending' };
  const targets = combineTargets(registry, [release], desktop, '0.2.1-rc.5');
  assert.equal(targets.length, 2); assert.equal(targets[0].channels.length, 3); assert.equal(targets[1].npm.integrity, null);
});
test('Desktop feed, archive, signer and unknown runtime are validated', () => {
  const sha512 = Buffer.alloc(64).toString('base64');
  const feed = `version: ${version}\nsha512: ${sha512}\npath: https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-${version}-mac-arm64.zip\n`;
  assert.equal(parseDesktopFeed(feed).version, version); assert.throws(() => parseDesktopFeed(feed.replace('download.deepseek.com', 'evil.invalid')));
  assert.throws(() => validateArchivePaths(['DeepSeek Harness.app/../escape'])); assert.throws(() => validateSignature('TeamIdentifier=OTHER'));
  assert.throws(() => validateDesktopRuntime({ sdk: version, platform:'darwin', arch:'arm64', node:'unknown' }, version));
});
test('checking environment has isolated homes and no inherited API credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-env-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const old = process.env.TEST_API_KEY; process.env.TEST_API_KEY = 'secret'; t.after(() => { if (old === undefined) delete process.env.TEST_API_KEY; else process.env.TEST_API_KEY = old; });
  const env = await isolatedEnv(directory); assert.equal(env.TEST_API_KEY, undefined); assert.equal(env.HOME, join(directory, 'home')); assert(env.DSH_HOME.startsWith(directory));
});
test('writes are restricted to this repository', () => { assert.throws(() => assertRepository('other/repo')); assert.equal(assertRepository('takboo/dsh-coopanion'), 'takboo/dsh-coopanion'); });

test('a known preparation assertion failure is reported as failed rather than missing-platform retry', () => {
  const components = { sdk: { ...completed, status: 'retry' } };
  applyPreparationFailure(components, { status: 'failed', sourceCommit, target, productionSourcesStable: true, reason: 'baseline assertion failed' }, target, sourceCommit);
  assert.equal(components.sdk.status, 'failed'); assert.equal(overallStatus(components, false), 'failed');
});
test('three platforms using different candidate archive bytes cannot pass', () => {
  const reports = ['linux/x64','darwin/arm64','win32/x64'].map((value,i) => { const [platform,arch] = value.split('/'); return { platform,arch,status:'partial',archiveSha256:String(i) }; });
  assert.equal(completedComponents(target, reports, {}, { run:'123', sourceCommit }).sdk.status, 'failed');
});

test('structured stdout remains parseable and stderr remains in the evidence log', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-stdout-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await command({ stages: [] }, directory, 'structured', process.execPath, ['-e', 'console.error("carrier diagnostic");console.log(JSON.stringify({runtime:"verified"}))'], { captureStdout: true });
  assert.deepEqual(JSON.parse(result), { runtime: 'verified' });
  assert.match(await readFile(join(directory, 'structured.log'), 'utf8'), /carrier diagnostic/);
});

test('Desktop resolution preserves package subpath exports, relative chunks and explicit Host file URLs', async t => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'coopanion-asar-resolve-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = join(directory, 'DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
  const client = join(directory, 'client');
  for (const [base, label] of [[sdk, 'asar'], [client, 'npm']]) {
    const pkg = join(base, 'node_modules/@deepseek-ai/dsh-compat-fixture'); await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './lib/index.js', './operations': './lib/operations.js', './package.json': './package.json' } }));
    await writeFile(join(pkg, 'lib/index.js'), "export { carrier } from './chunk.js';");
    await writeFile(join(pkg, 'lib/chunk.js'), `export const carrier = '${label}';`);
    await writeFile(join(pkg, 'lib/operations.js'), `export const operation = '${label}-operation';`);
  }
  const explicit = pathToFileURL(join(client, 'node_modules/@deepseek-ai/dsh-compat-fixture/lib/index.js')).href;
  const probe = join(client, 'probe.mjs');
  await writeFile(probe, `import {carrier} from '@deepseek-ai/dsh-compat-fixture'; import {operation} from '@deepseek-ai/dsh-compat-fixture/operations'; import {carrier as explicit} from '${explicit}';console.log(JSON.stringify([carrier,operation,explicit]));`);
  const bootstrap = new URL('../scripts/compatibility/desktop-bootstrap.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--import='+bootstrap, probe], { env: { ...process.env, COOPANION_ASAR_SDK: sdk }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ['asar','asar-operation','asar']);
});
