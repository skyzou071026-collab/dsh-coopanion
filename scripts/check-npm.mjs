import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { npmVersionState, packageName, readJson } from './release-support.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  report: { type: 'string' },
  'github-output': { type: 'boolean', default: false },
  'require-published': { type: 'boolean', default: false },
} });
assert.equal(positionals.length, 1, 'pass one verified tarball');
assert.ok(values.report, '--report is required');
const report = readJson(values.report);
assert.equal(report.name, packageName);
assert.equal(report.integrity, `sha512-${createHash('sha512').update(readFileSync(positionals[0])).digest('base64')}`, 'tarball differs from verified report');
const state = await npmVersionState(report.name, report.version, report.integrity, fetch, { waitForPublished: values['require-published'] });
if (values['require-published']) assert.equal(state, 'published', 'npm has not published the verified bytes');
if (values['github-output']) {
  assert.ok(process.env.GITHUB_OUTPUT);
  appendFileSync(process.env.GITHUB_OUTPUT, `published=${state === 'published'}\n`);
}
console.log(`npm ${report.name}@${report.version}: ${state}`);
