import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await rm('dist', { recursive: true, force: true });
await build({ entryPoints: ['src/index.ts', 'src/bridge.ts', 'src/model.ts'], outdir: 'dist', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
await build({ entryPoints: ['src/character-store.ts', 'src/companion-store.ts', 'src/figure-server.ts', 'src/diagnostics.ts'], outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await build({ entryPoints: ['web/reply-markdown.js'], outfile: 'web/markdown-runtime.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', minify: true });
await build({ entryPoints: ['src/client/index.ts'], outfile: 'dist/client.js', bundle: true,
  // DSH supplies its public peers and React. Runtime dependencies such as zod
  // must be bundled because they have no DSH browser module factory.
  external: [...Object.keys(manifest.peerDependencies), 'react', 'react-dom'],
  platform: 'browser', format: 'cjs', target: 'chrome130', jsx: 'automatic', loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});

// Bind source exports without requiring a Git checkout to rebuild them.
const { createHash } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { writeFile, readdir } = await import('node:fs/promises');
const inputPaths = ['scripts/build.mjs', 'package.json', 'npm-shrinkwrap.json'];
async function collectInputs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await collectInputs(path);
    else if (entry.isFile() && path !== 'web/markdown-runtime.js') inputPaths.push(path);
  }
}
for (const directory of ['src', 'desktop', 'web']) await collectInputs(directory);
const inputs = Object.fromEntries(await Promise.all(inputPaths.sort().map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
let commit = null, dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* Corresponding-source exports need no .git directory. */ }
await writeFile('dist/build-info.json', JSON.stringify({ schema: 1, commit, dirty, productDigest: createHash('sha256').update(JSON.stringify(inputs)).digest('hex') }, null, 2) + '\n');
