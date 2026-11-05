import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { readManifest, nameIn, type FigureManifest } from './upstream/packs.ts';

export const BUILTIN_ID = 'whale';
export const PACK_LIMIT = 128 * 1024 * 1024;
export interface CharacterView extends FigureManifest { base: string; builtin: boolean; revision: string; }
export interface CharacterLibrary { characters: CharacterView[]; selected: string; schemes: Record<string, string>; problems: string[]; }
const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && !['whale', 'coo'].includes(id);
const validHash = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
export const safePath = (path: string) => !!path && path.length <= 512 && !/[\\:\x00-\x1f?#]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');

export function knownScheme(pack: FigureManifest, value = ''): string {
  if (pack.presets.some(p => p.id === value)) return value;
  const parts = value.split('-');
  return pack.axes.map((a, i) => a.options.some(o => o.id === parts[i]) ? parts[i] : a.options[0]!.id).join('-');
}

/** API 2 packs are immutable, content-addressed directories. Scripts run only in the figure sandbox. */
export class CharacterStore {
  constructor(readonly directory: string, readonly builtinDirectory: string) {}
  private async atomic(file: string, value: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, value, { mode: 0o600 }); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
  }
  private manifest(directory: string, builtin = false): FigureManifest {
    const manifest = readManifest(directory, builtin);
    if (typeof manifest === 'string') throw new Error(manifest);
    return manifest;
  }
  async load(id: string): Promise<CharacterView> {
    if (id === BUILTIN_ID) return { ...this.manifest(this.builtinDirectory, true), base: './upstream/whale/', builtin: true, revision: 'builtin' };
    if (!validId(id)) throw new Error('无效的角色 id');
    const index = join(this.directory, `${id}.json`);
    if ((await stat(index)).size > 256) throw new Error('角色索引无效');
    const { revision } = JSON.parse(await readFile(index, 'utf8'));
    if (typeof revision !== 'string' || !validHash(revision)) throw new Error('角色索引无效，请重新导入 API 2 角色包');
    const manifest = this.manifest(join(this.directory, `${id}-${revision}`));
    if (manifest.id !== id) throw new Error('角色包与索引不匹配');
    return { ...manifest, base: `./packs/${id}/${revision}/`, builtin: false, revision };
  }
  async list(): Promise<CharacterLibrary> {
    await mkdir(this.directory, { recursive: true });
    const characters = [await this.load(BUILTIN_ID)], problems: string[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json') || !validId(file.slice(0, -5))) continue;
      try { characters.push(await this.load(file.slice(0, -5))); }
      catch (error) { problems.push(`无法读取角色 ${file.slice(0, -5)}：${error instanceof Error ? error.message : '索引错误'}`); }
    }
    let selected = BUILTIN_ID;
    const schemes: Record<string, string> = {};
    try {
      const file = join(this.directory, '.selection.json');
      if ((await stat(file)).size > 16 * 1024) throw new Error('选择记录过大');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (characters.some(p => p.id === saved.id)) selected = saved.id;
      for (const pack of characters) schemes[pack.id] = knownScheme(pack, typeof saved.schemes?.[pack.id] === 'string' ? saved.schemes[pack.id] : '');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push('角色选择记录损坏，已恢复大肥鱼'); }
    for (const pack of characters) schemes[pack.id] ??= knownScheme(pack);
    return { characters, selected, schemes, problems };
  }
  async import(bytes: Uint8Array): Promise<CharacterLibrary & { importedId: string }> {
    if (bytes.length > PACK_LIMIT) throw new Error('角色包不能超过 128 MiB');
    let total = 0, count = 0;
    const files = unzipSync(bytes, { filter(entry) {
      if (++count > 2048 || !safePath(entry.name.replace(/\/$/, ''))) throw new Error('角色包文件路径或数量不合法');
      if (entry.originalSize > 16 * 1024 * 1024 || (total += entry.originalSize) > PACK_LIMIT) throw new Error('解压后的角色包过大');
      return !entry.name.endsWith('/');
    } });
    const roots = Object.keys(files).filter(p => (p === 'figure.json' || p.endsWith('/figure.json')) && p.split('/').length <= 4);
    if (roots.length !== 1) throw new Error('请导入包含一个 figure.json（API 2）的 ZIP；旧 .dshpet 已不再支持');
    const prefix = roots[0]!.slice(0, -'figure.json'.length);
    if (files[roots[0]!]!.length > 256 * 1024) throw new Error('figure.json 过大');
    await mkdir(this.directory, { recursive: true });
    const staging = await mkdtemp(join(this.directory, '.import-'));
    try {
      let actual = 0;
      for (const [path, data] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length);
        if (!safePath(relative) || data.length > 16 * 1024 * 1024 || (actual += data.length) > PACK_LIMIT) throw new Error('角色包文件不合法或过大');
        const full = join(staging, relative);
        await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, data, { mode: 0o600 });
      }
      const manifest = this.manifest(staging);
      if (!validId(manifest.id)) throw new Error('该 id 是内置角色的保留 id');
      for (const file of [manifest.entry, manifest.model, manifest.thumb].filter((v): v is string => !!v)) {
        if (!safePath(file) || !(await stat(join(staging, file))).isFile()) throw new Error(`角色文件缺失：${file}`);
      }
      if (!/\.(m?js)$/.test(manifest.entry)) throw new Error('entry 必须是 JavaScript 模块');
      if (manifest.model) JSON.parse(await readFile(join(staging, manifest.model), 'utf8'));
      const revision = createHash('sha256').update(bytes).digest('hex');
      const destination = join(this.directory, `${manifest.id}-${revision}`);
      try { await stat(destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await rename(staging, destination); }
      await this.atomic(join(this.directory, `${manifest.id}.json`), JSON.stringify({ revision }));
      return { ...await this.list(), importedId: manifest.id };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async select(id: string, scheme?: string): Promise<void> {
    const pack = await this.load(id), library = await this.list();
    library.schemes[id] = knownScheme(pack, scheme ?? library.schemes[id]);
    await this.atomic(join(this.directory, '.selection.json'), JSON.stringify({ id, schemes: library.schemes }));
  }
  async remove(id: string): Promise<CharacterLibrary> {
    if (!validId(id)) throw new Error('不能删除内置角色或无效的角色 id');
    await this.load(id); await rm(join(this.directory, `${id}.json`));
    for (const file of await readdir(this.directory)) {
      if (file.startsWith(`${id}-`) && validHash(file.slice(id.length + 1))) await rm(join(this.directory, file), { recursive: true, force: true });
    }
    const library = await this.list(); await this.select(library.selected); return library;
  }
  async asset(id: string, revision: string, path: string): Promise<Buffer> {
    if (!validId(id) || !validHash(revision) || !safePath(path)) throw new Error('无效的角色资源');
    return readFile(join(this.directory, `${id}-${revision}`, path));
  }
}
export { nameIn };
