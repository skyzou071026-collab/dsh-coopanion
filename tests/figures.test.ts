import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { CharacterStore, knownScheme, PACK_LIMIT } from '../src/character-store.ts';
import { createPetServer } from '../src/figure-server.ts';
import { readManifest } from '../src/upstream/packs.ts';

const builtin = resolve('web/upstream/whale');
const manifest = JSON.parse(await readFile('examples/star/figure.json', 'utf8'));
const entry = await readFile('examples/star/figure.js');
const archive = (value = manifest, extra: Record<string, Uint8Array> = {}, wrapper = '') => zipSync({ [wrapper + 'figure.json']: strToU8(JSON.stringify(value)), [wrapper + 'figure.js']: entry, ...extra });
async function withStore(test: (store: CharacterStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-figures-'));
  try { await test(new CharacterStore(directory, builtin)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('upstream API 2 packs', () => {
  it('loads the native whale, its eight dress presets and full motion vocabulary', () => {
    const m = readManifest(builtin, true);
    expect(typeof m).toBe('object');
    if (typeof m === 'string') throw new Error(m);
    expect(m.api).toBe(2); expect(m.presets).toHaveLength(8);
    expect(m.vocab.map(w => w.id)).toEqual(expect.arrayContaining(['dance', 'sleep', 'wave', 'thinking']));
    expect(m.credits?.map(c => c.name)).toEqual(expect.arrayContaining(['ZipZipPipe']));
    expect(knownScheme(m, 'missing')).toBe('deepseek');
  });
  it('imports wrapped folders, retains executable modules without executing them, and saves outfits across restarts', async () => withStore(async store => {
    const result = await store.import(archive(manifest, {}, 'repository-main/star/'));
    expect(result.importedId).toBe('paper-star');
    await store.select('paper-star', 'night');
    const reopened = new CharacterStore(store.directory, builtin), saved = await reopened.list();
    expect(saved.selected).toBe('paper-star'); expect(saved.schemes['paper-star']).toBe('night');
    const pack = await reopened.load('paper-star');
    expect(pack.base).toMatch(/^\.\/packs\/paper-star\/[a-f0-9]{64}\/$/);
    expect((await reopened.asset(pack.id, pack.revision, 'figure.js')).toString()).toContain('kit.createBody');
    const changed = { ...manifest, version: '2.1.0' };
    await reopened.import(archive(changed));
    expect((await reopened.load('paper-star')).version).toBe('2.1.0');
    expect((await reopened.list()).schemes['paper-star']).toBe('night');
    expect((await reopened.remove('paper-star')).selected).toBe('whale');
    expect((await readdir(store.directory)).some(p => p.startsWith('paper-star-'))).toBe(false);
    await expect(reopened.remove('whale')).rejects.toThrow(/内置/);
  }));
  it('rejects legacy packs, traversal, reserved ids, unsupported APIs and oversized entries before installing', async () => withStore(async store => {
    await expect(store.import(zipSync({ 'character.json': strToU8('{}') }))).rejects.toThrow(/API 2/);
    await expect(store.import(archive(manifest, { '../escape.js': strToU8('') }))).rejects.toThrow(/路径/);
    await expect(store.import(archive({ ...manifest, id: 'whale' }))).rejects.toThrow(/保留/);
    await expect(store.import(archive({ ...manifest, api: 3 }))).rejects.toThrow(/更新/);
    await expect(store.import(archive({ ...manifest, entry: '../figure.js' }))).rejects.toThrow(/不合法/);
    const bytes = archive(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 28; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, PACK_LIMIT + 1, true); break; }
    await expect(store.import(bytes)).rejects.toThrow(/过大/);
    expect((await store.list()).characters.map(p => p.id)).toEqual(['whale']);
  }));
  it('keeps an installed revision when an update has a missing model or entry', async () => withStore(async store => {
    await store.import(archive()); const revision = (await store.load('paper-star')).revision;
    await expect(store.import(archive({ ...manifest, model: 'missing.json' }))).rejects.toThrow();
    expect((await store.load('paper-star')).revision).toBe(revision);
    expect((await readdir(store.directory)).some(p => p.startsWith('.import-'))).toBe(false);
    await writeFile(join(store.directory, 'paper-star.json'), JSON.stringify({ revision: '../outside' }));
    await expect(store.load('paper-star')).rejects.toThrow(/索引/);
  }));
});

it('serves accepted pipelined requests after the listening socket closes', async () => withStore(async store => {
  const listing = await store.list();
  let release!: () => void, entered!: () => void, second!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const firstRequest = new Promise<void>(resolve => { entered = resolve; });
  const secondRequest = new Promise<void>(resolve => { second = resolve; });
  store.list = async () => { entered(); await blocked; return listing; };
  const server = createPetServer({ webRoot: resolve('web'), store });
  const handler = server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const escaped: unknown[] = [];
  let requests = 0;
  // Observe escaped async listener errors without letting the test runner's
  // process-wide rejection handler replace the assertion about this request.
  server.removeListener('request', handler);
  server.on('request', (req, res) => {
    if (++requests === 2) second();
    void Promise.resolve(handler(req, res)).catch(error => {
      escaped.push(error); res.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const socket = createConnection({ host: '127.0.0.1', port });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, 'connect'); socket.setEncoding('utf8');
    let response = ''; socket.on('data', part => { response += part; });
    const ended = once(socket, 'close');
    const send = (connection: string) => socket.write(`GET /api/characters/list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: ${connection}\r\n\r\n`);
    send('keep-alive'); await firstRequest;
    const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
    expect(server.address()).toBeNull();
    send('close');
    await Promise.race([secondRequest, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Queued request did not arrive')), 2000); })]);
    release(); await ended; await closed;
    expect(escaped).toEqual([]);
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
  } finally { clearTimeout(deadline); release(); socket.destroy(); server.close(); }
}));

// This checks the complete source archive's contents, including original assets.
// Disk and ZIP work can exceed Vitest's default 5 s on the Windows test VM.
it('serves the frame with an opaque-origin CSP, rejects cross-origin mutations and offers matching source', async () => withStore(async store => {
  await store.import(archive());
  const server = createPetServer({ webRoot: resolve('web'), store, prefix: '/test-token/' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, base = origin + '/test-token/';
  try {
    const frame = await fetch(base + 'upstream/figure-frame.html');
    expect(frame.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(frame.headers.get('content-security-policy')).toContain(origin + '/test-token/packs/');
    expect(frame.headers.get('access-control-allow-origin')).toBe('*');
    expect(await frame.text()).toContain('./figure-frame.js');
    expect((await fetch(origin + '/index.html')).status).toBe(404);
    expect((await fetch(base + 'api/characters/select', { method: 'POST', headers: { Origin: 'null' }, body: '{"id":"whale"}' })).status).toBe(403);
    const rejectedHost = await new Promise<number>(resolve => { const req = request(base + 'index.html', { headers: { Host: 'rebind.example' } }, response => { response.resume(); resolve(response.statusCode!); }); req.end(); });
    expect(rejectedHost).toBe(403);
    const pack = await store.load('paper-star');
    expect((await fetch(base + pack.base.slice(2) + 'figure.js')).headers.get('content-type')).toMatch(/javascript/);
    const response = await fetch(base + 'source'); expect(response.status).toBe(200);
    const source = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(strFromU8(source['src/figure-server.ts']!)).toContain('sourceArchive');
    expect(strFromU8(source['LICENSE']!)).toContain('AFFERO');
    expect(source['web/upstream/whale/model.json']).toBeDefined();
    expect(source['scripts/build.mjs']).toBeDefined(); expect(source['npm-shrinkwrap.json']).toBeDefined();
    expect(Object.keys(source).some(p => /node_modules|figures-v2|\.aws/.test(p))).toBe(false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}), 30_000);

it('bounds untrusted hit areas and only accepts touch events following real input', async () => {
  // @ts-expect-error The upstream browser module is JavaScript.
  const { readLayout, onBody, touchGate } = await import('../web/upstream/body-host.js');
  const layout = readLayout({ box: { x: -100, y: -100, w: 1e9, h: 1e9 }, hit: [{ x: 250, y: 250, r: 1e9 }], bubble: { x: Infinity, y: -100 } }, { W: 1200, H: 800, S: .5 });
  expect(layout.box.w).toBeLessThan(300); expect(layout.bubble).toEqual({ x: 0, y: 0 });
  expect(onBody(layout, { x: 1000, y: 600 })).toBe(false);
  const gate = touchGate(); expect(gate.take('poke', 1)).toBe(false);
  gate.input(10); expect(gate.take('throw', 30)).toBe(true); expect(gate.take('crash', 5000)).toBe(true);
  expect(gate.take('crash', 5001)).toBe(false);
});
