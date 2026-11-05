import { readFileSync } from 'node:fs';
import { readJson, releaseNotes, verifyMetadata } from './release-support.mjs';

const pkg = readJson('package.json');
verifyMetadata(pkg, readJson('npm-shrinkwrap.json'));
releaseNotes(readFileSync('docs/release-notes.md', 'utf8'), pkg.version);
console.log(`Release metadata verified: ${pkg.name}@${pkg.version}`);
