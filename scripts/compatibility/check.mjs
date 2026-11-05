import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, commit, copySource, sourceDigest, isolatedEnv, command, npmCli, StageError } from './runner.mjs';
import { FetchError, request } from './common.mjs';
const parent = join(root, '.cache/compatibility'); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'check-'));
const workspace = join(scratch, 'workspace'), runtime = join(scratch, 'runtime');
const output = resolve(process.env.DSH_REPORT_DIR ?? join(scratch, 'report'));
const bundle = resolve(process.env.DSH_CANDIDATE_DIR ?? 'candidate');
await mkdir(output, { recursive: true });
const before = await sourceDigest();
const report = { schema: 1, sourceCommit: commit(), platform: process.platform, arch: process.arch, status: 'running', stages: [], productionAdmissionChanged: false };
const env = await isolatedEnv(scratch);
const npm = (name, args, opts = {}) => command(report, output, name, process.execPath, [npmCli(), ...args], { cwd: workspace, env, ...opts });
try {
  report.target = JSON.parse(process.env.DSH_TARGET_JSON); report.version = report.target.version;
  const meta = JSON.parse(await readFile(join(bundle, 'candidate.json'), 'utf8'));
  assert.equal(meta.version, report.version); assert.equal(meta.sourceCommit, report.sourceCommit); assert.equal(meta.targetIdentity, report.target.identity);
  const baseline = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const archive = join(bundle, `dsh-coopanion-${baseline.version}.tgz`);
  report.archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex'); assert.equal(report.archiveSha256, meta.archiveSha256);
  const metadata = await request(`https://registry.npmjs.org/@deepseek-ai%2Fdsh/${report.version}`);
  assert.equal(metadata.dist.integrity, report.target.npm.integrity);
  await copySource(workspace);
  const proposal = JSON.parse(await readFile(join(bundle, 'proposal.json'), 'utf8'));
  const { validateProposal } = await import('./proposal.mjs');
  for (const [path, content] of Object.entries(validateProposal(proposal, baseline, report.version, report.sourceCommit))) await writeFile(join(workspace, path), content);
  await npm('platform-install', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { setup: true });
  await npm('host-install', ['install', '--prefix', runtime, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${report.version}`], { setup: true, timeout: 10 * 60000 });
  await command(report, output, 'normal-admission', process.execPath, [join(workspace, 'scripts/compatibility/admission.mjs'), runtime, report.version, join(bundle, 'candidate.json')], { cwd: workspace, env });
  Object.assign(env, { DSH_TEST_VERSION: report.version, DSH_TEST_RUNTIME: runtime, DSH_TEST_PACKAGE_DIR: bundle });
  await npm('candidate-installation', ['run', 'test:install'], { timeout: 25 * 60000 });
  report.status = 'partial'; report.reason = 'Actual Loader, browser Client, native companion, notification/goal/session contracts and recovery passed on the same candidate archive; source review remains required.';
} catch (error) { report.status = error instanceof StageError ? error.status : error instanceof FetchError ? 'retry' : 'failed'; report.reason = String(error.stack ?? error).slice(0, 6000); }
finally {
  for (const name of await readdir(join(workspace, 'artifacts')).catch(() => [])) if (/\.(json|png)$/.test(name)) await cp(join(workspace, 'artifacts', name), join(output, name));
  report.productionSourcesStable = before === await sourceDigest();
  if (!report.productionSourcesStable) { report.status = 'failed'; report.reason = 'Source files changed during candidate installation'; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: report.status, reason: report.reason })); process.exitCode = report.status === 'partial' ? 0 : 1;
}
