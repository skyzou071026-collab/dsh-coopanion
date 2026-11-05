import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';
const { CharacterStore, safePath } = createRequire(import.meta.url)('../dist/character-store.cjs');
const source = process.argv[2];
if (!source) throw new Error('用法：npm run character:pack -- <API 2 角色目录> [输出.zip]');
const root = resolve(source), files = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (!safePath(relative) || entry.isSymbolicLink()) throw new Error(`不支持的文件路径：${relative}`);
    if (entry.isDirectory()) await collect(join(directory, entry.name), relative + '/');
    else if (entry.isFile()) files[relative] = await readFile(join(directory, entry.name));
  }
}
await collect(root);
const bytes = zipSync(files, { level: 6 });
const staging = await mkdtemp(join(tmpdir(), 'dsh-figure-pack-'));
try {
  const store = new CharacterStore(staging, resolve('web/upstream/whale'));
  const result = await store.import(bytes);
  const output = resolve(process.argv[3] ?? `${result.importedId}.zip`);
  await writeFile(output, bytes); console.log(`API 2 角色包已验证：${output}（${bytes.length} 字节）`);
} finally { await rm(staging, { recursive: true, force: true }); }
