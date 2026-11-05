import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, commit, copySource, sourceDigest, isolatedEnv, command, npmCli, StageError } from './runner.mjs';
import { targetManifest, candidateLock } from './proposal.mjs';
import { discover } from './discover.mjs';
import { FetchError, request } from './common.mjs';
const parent = join(root, '.cache/compatibility'); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'prepare-'));
const workspace = join(scratch, 'workspace'), output = resolve(process.env.DSH_REPORT_DIR ?? join(scratch, 'report'));
await mkdir(output, { recursive: true });
const baseline = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const before = await sourceDigest();
const report = { schema: 1, kind: 'prepare', sourceCommit: commit(), platform: process.platform, arch: process.arch, status: 'running', stages: [], productionAdmissionChanged: false };
const env = await isolatedEnv(scratch);
const npm = (name, args, opts = {}) => command(report, output, name, process.execPath, [npmCli(), ...args], { cwd: workspace, env, ...opts });
try {
  report.target = process.env.DSH_TARGET_JSON ? JSON.parse(process.env.DSH_TARGET_JSON) : (await discover({ manual: process.env.DSH_VERSION, local: true }))[0];
  assert(report.target, 'No target found; use DSH_VERSION for a manual rehearsal');
  report.version = report.target.version;
  if (!report.target.npm.integrity) throw new FetchError('Wait for the exact npm publication');
  const metadata = await request(`https://registry.npmjs.org/@deepseek-ai%2Fdsh/${report.version}`);
  assert.equal(metadata.dist.integrity, report.target.npm.integrity, 'Target changed after discovery');
  await copySource(workspace);
  await npm('baseline-install', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { setup: true });
  if (report.target.runSdk !== false) await npm('baseline-typecheck', ['run', 'typecheck']);
  if (report.target.runSdk !== false) await npm('baseline-tests', ['test']);
  const manifest = targetManifest(baseline, report.version);
  await writeFile(join(workspace, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lock = candidateLock(JSON.parse(await readFile(join(workspace, 'npm-shrinkwrap.json'), 'utf8')), manifest);
  await writeFile(join(workspace, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
  await npm('target-lock', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { setup: true });
  await npm('target-install', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { setup: true });
  for (const task of ['verify:metadata', 'typecheck']) await npm('candidate-' + task.replace(':', '-'), ['run', task]);
  if (report.target.runSdk !== false) await npm('candidate-tests', ['test']);
  await npm('candidate-build', ['run', 'build']);
  await npm('candidate-character', ['run', 'character:pack', '--', 'examples/star', 'paper-star.zip']);
  for (const task of report.target.runSdk === false ? [] : ['test:ui', 'test:notification-ui', 'test:inbox-ui']) await npm('candidate-' + task.replaceAll(':', '-'), ['run', task]);
  await npm('candidate-pack', ['pack', '--ignore-scripts', '--pack-destination', output]);
  const packed = join(output, `takboo-dsh-coopanion-${manifest.version}.tgz`);
  await copyFile(packed, join(output, `dsh-coopanion-${manifest.version}.tgz`));
  await npm('candidate-package', ['run', 'verify:package', '--', packed]);
  await copyFile(join(workspace, 'paper-star.zip'), join(output, 'paper-star.zip'));
  const files = {};
  for (const path of ['package.json', 'npm-shrinkwrap.json']) files[path] = await readFile(join(workspace, path), 'utf8');
  await writeFile(join(output, 'proposal.json'), JSON.stringify({ version: report.version, sourceCommit: report.sourceCommit, files }, null, 2) + '\n');
  report.archiveSha256 = createHash('sha256').update(await readFile(packed)).digest('hex');
  await writeFile(join(output, 'candidate.json'), JSON.stringify({ version: report.version, sourceCommit: report.sourceCommit, targetIdentity: report.target.identity, archiveSha256: report.archiveSha256, baselineManifest: baseline }, null, 2) + '\n');
  report.status = 'partial'; report.reason = 'Candidate package built and browser contracts passed; platform installation and source review remain separate.';
} catch (error) {
  report.status = error instanceof StageError ? error.status : error instanceof FetchError ? 'retry' : 'failed'; report.reason = String(error.stack ?? error).slice(0, 6000);
} finally {
  report.productionSourcesStable = before === await sourceDigest();
  if (!report.productionSourcesStable) { report.status = 'failed'; report.reason = 'Source files changed during candidate preparation'; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: report.status, reason: report.reason })); process.exitCode = report.status === 'partial' ? 0 : 1;
}
