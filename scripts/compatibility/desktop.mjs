import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, cp } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { root, commit, copySource, sourceDigest, isolatedEnv, command, npmCli, StageError } from './runner.mjs';
import { FetchError } from './common.mjs';
import { validateDesktopTarget, validateArchivePaths, validateSignature, validateDesktopRuntime } from './desktop-artifact.mjs';
import { validateProposal } from './proposal.mjs';
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const parent = join(root, '.cache/compatibility'); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'desktop-')), workspace = join(scratch, 'workspace');
const output = resolve(process.env.DSH_REPORT_DIR ?? join(scratch, 'report')), bundle = resolve(process.env.DSH_CANDIDATE_DIR ?? 'candidate');
await mkdir(output, { recursive: true }); const before = await sourceDigest();
const report = { schema: 1, kind: 'desktop', sourceCommit: commit(), platform: 'darwin', arch: 'arm64', status: 'running', stages: [], productionAdmissionChanged: false,
  limits: ['Signed official Host Electron and ASAR contracts checked separately; installed-flow uses published Web Host/client and the companion declared Electron dependency; no native Desktop shell, physical input, notification-center or real account/model acceptance.'] };
const env = await isolatedEnv(scratch);
const run = (name, file, args, opts = {}) => command(report, output, name, file, args, { cwd: workspace, env, ...opts });
try {
  report.target = JSON.parse(process.env.DSH_TARGET_JSON); report.version = report.target.version;
  const desktop = validateDesktopTarget(report.target);
  const meta = JSON.parse(await readFile(join(bundle, 'candidate.json'), 'utf8'));
  assert.equal(meta.sourceCommit, report.sourceCommit); assert.equal(meta.targetIdentity, report.target.identity); assert.equal(meta.version, report.version);
  const baseline = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const archive = join(bundle, `dsh-coopanion-${baseline.version}.tgz`);
  report.archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex'); assert.equal(report.archiveSha256, meta.archiveSha256);
  await copySource(workspace);
  const proposal = JSON.parse(await readFile(join(bundle, 'proposal.json'), 'utf8'));
  for (const [path, content] of Object.entries(validateProposal(proposal, baseline, report.version, report.sourceCommit))) await writeFile(join(workspace, path), content);
  await run('desktop-dependencies', process.execPath, [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { setup: true });
  const zip = join(scratch, 'official.zip'), sha512 = createHash('sha512'), sha256 = createHash('sha256'); let bytes = 0;
  let response;
  try { response = await fetch(desktop.path, { redirect: 'error', signal: AbortSignal.timeout(10 * 60000) }); }
  catch (e) { throw new FetchError(e.message); }
  if (!response.ok) throw new FetchError(`Official ZIP HTTP ${response.status}`);
  try { await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) {
    bytes += chunk.length; if (bytes > 2 * 1024 ** 3) return done(new Error('Official ZIP exceeds 2 GiB limit'));
    sha512.update(chunk); sha256.update(chunk); done(null, chunk);
  } }), createWriteStream(zip, { flags: 'wx' })); } catch (e) { throw new FetchError(e.message); }
  assert.equal(sha512.digest('base64'), desktop.sha512, 'Official ZIP integrity mismatch');
  report.artifact = { ...desktop, sha256: sha256.digest('hex'), bytes };
  validateArchivePaths((await run('archive-list', '/usr/bin/tar', ['-tf', zip])).trim().split(/\r?\n/));
  const extracted = join(scratch, 'application'); await mkdir(extracted);
  await run('archive-extract', '/usr/bin/tar', ['-xf', zip, '-C', extracted]);
  async function contained(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), rel = relative(extracted, await realpath(path));
    assert(rel !== '..' && !rel.startsWith('..' + sep), 'Archive symlink escapes extraction root');
    if (entry.isDirectory()) await contained(path);
  } }
  await contained(extracted);
  const application = join(extracted, 'DeepSeek Harness.app'), executable = join(application, 'Contents/MacOS/DeepSeek Harness');
  await run('signature-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  validateSignature(await run('signature-identity', '/usr/bin/codesign', ['-dv', '--verbose=4', application]));
  const sdk = join(application, 'Contents/Resources/app.asar/dsh');
  const electronEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', COOPANION_ASAR_SDK: sdk, COOPANION_ASAR_RESOLUTION_LOG: join(scratch, 'asar-resolutions.ndjson'), npm_execpath: npmCli(),
    NARB_NATIVE_CACHE_DIR: join(scratch, 'native-cache') };
  report.runtime = JSON.parse(await run('runtime-inspect', executable, ['--expose-internals', 'scripts/compatibility/inspect-desktop.mjs', sdk], { env: electronEnv, captureStdout: true }));
  validateDesktopRuntime(report.runtime, report.version);
  const runtime = join(scratch, 'npm-runtime');
  await run('web-runtime', process.execPath, [npmCli(), 'install', '--prefix', runtime, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${report.version}`], { setup: true });
  const asarArgs = ['--expose-internals', '--import=' + join(workspace, 'scripts/compatibility/desktop-bootstrap.mjs')];
  // Bare SDK imports and explicit published Host module URLs are redirected to the inspected ASAR.
  await run('asar-contract', executable, [...asarArgs, 'tests/notification-host-contract.mjs', '--runtime', runtime, '--version', report.version], { env: electronEnv });
  await run('asar-goal', executable, [...asarArgs, 'tests/goal-host-contract.mjs', '--runtime', runtime, '--version', report.version, '--package', archive], { env: electronEnv });
  await run('asar-session', executable, [...asarArgs, 'tests/session-host-contract.mjs', '--verify-plugin', '--runtime', runtime, '--version', report.version, '--package', archive], { env: electronEnv });
  report.asarSources = [...new Map((await readFile(electronEnv.COOPANION_ASAR_RESOLUTION_LOG, 'utf8')).trim().split('\n').map(line => { const row = JSON.parse(line); return [row.name, row]; })).values()];
  for (const required of ['dsh-session', 'dsh-goal', 'dsh-api-session-controller']) assert(report.asarSources.some(row => row.name === required), 'Required actual ASAR Host source was not exercised');
  // Full GUI uses published Web Host/client in the official carrier; actual ASAR contracts were checked separately.
  delete electronEnv.NODE_OPTIONS; delete electronEnv.COOPANION_ASAR_SDK; delete electronEnv.COOPANION_ASAR_RESOLUTION_LOG;
  // The Host uses the signed DSH carrier; the companion uses its declared Electron dependency, exactly as in product startup.
  Object.assign(electronEnv, { DSH_TEST_RUNTIME: runtime, DSH_TEST_VERSION: report.version, DSH_TEST_PACKAGE_DIR: bundle });
  await run('official-electron-installation', executable, ['--expose-internals', 'tests/install.mjs'], { env: electronEnv, timeout: 30 * 60000 });
  report.status = 'partial'; report.reason = 'Signed official carrier and ASAR Host contracts plus installed companion integration passed; source review and physical acceptance remain separate.';
} catch (error) { report.status = error instanceof StageError ? error.status : error instanceof FetchError ? 'retry' : 'failed'; report.reason = String(error.stack ?? error).slice(0, 6000); }
finally {
  for (const name of await readdir(join(workspace, 'artifacts')).catch(() => [])) if (/\.(json|png)$/.test(name)) await cp(join(workspace, 'artifacts', name), join(output, name));
  report.productionSourcesStable = before === await sourceDigest();
  if (!report.productionSourcesStable) { report.status = 'failed'; report.reason = 'Source files changed during Desktop verification'; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: report.status, reason: report.reason })); process.exitCode = report.status === 'partial' ? 0 : 1;
}
