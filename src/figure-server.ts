import { createServer, type IncomingMessage } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { zipSync } from 'fflate';
import { CompanionStore, companionRequest } from './companion-store.ts';
import { CharacterStore, PACK_LIMIT, safePath } from './character-store.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8' };
async function requestBytes(req: IncomingMessage, limit = PACK_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求不能超过 128 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Corresponding source, including the vendored runtime, original assets, build scripts and lockfile. */
async function sourceArchive(project: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  async function add(relative: string) {
    for (const entry of await readdir(join(project, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await add(next);
      else if (entry.isFile()) files[next] = await readFile(join(project, next));
    }
  }
  for (const dir of ['src', 'scripts', 'web', 'desktop', 'examples', 'docs', 'tests']) await add(dir);
  for (const file of ['package.json', 'npm-shrinkwrap.json', 'tsconfig.json', 'tsconfig.client.json', '.node-version', 'cordis.patch.yml', 'README.md', 'LICENSE', 'LICENSE-MIT', 'THIRD_PARTY_NOTICES.md']) files[file] = await readFile(join(project, file));
  return zipSync(files, { level: 6 });
}

/** Loopback asset host for the opaque-origin sandbox. Mutations require the trusted page's origin. */
export function createPetServer({ webRoot, store, companions, prefix = '/' }: { webRoot: string; store: CharacterStore; companions?: CompanionStore; prefix?: string }) {
  let operation = Promise.resolve();
  const server = createServer(async (req, res) => {
    // Accepted connections can deliver queued requests after close() has made
    // server.address() null. Their local port still identifies the bound origin.
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
      const path = decodeURIComponent(new URL(req.url!, origin).pathname);
      if (!path.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const relative = path.slice(prefix.length);
      if (relative === 'api/companionship' && companions) {
        if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        const request = companionRequest.parse(JSON.parse((await requestBytes(req, 8192)).toString('utf8')));
        if (request.type === 'remove') throw new Error('Unsupported companionship request');
        await store.load(request.characterId);
        json({ ok: true, value: await companions.request(request) }); return;
      }
      if (relative.startsWith('api/characters/')) {
        if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        const command = relative.slice('api/characters/'.length);
        if (req.method === 'GET' && command === 'list') { json({ ok: true, value: await store.list() }); return; }
        if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        const bytes = await requestBytes(req);
        const result = operation.then(async () => {
          if (command === 'import') return store.import(bytes);
          const data = JSON.parse(bytes.toString('utf8'));
          if (typeof data.id !== 'string' || (data.scheme !== undefined && typeof data.scheme !== 'string')) throw new Error('无效的角色请求');
          if (command === 'load') return store.load(data.id);
          if (command === 'select') return store.select(data.id, data.scheme);
          if (command === 'remove') {
            if (data.id === 'whale') throw new Error('内置角色不能删除');
            await store.load(data.id);
            if (companions) { const state = await companions.request({ type: 'read', characterId: data.id }); await companions.request({ type: 'remove', characterId: data.id, revision: state.revision, requestId: `remove-${data.id}-${Date.now()}` }); }
            return store.remove(data.id);
          }
          throw new Error('无效的角色操作');
        });
        operation = result.then(() => undefined, () => undefined);
        json({ ok: true, value: await result }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (relative === 'source') {
        const body = req.method === 'HEAD' ? undefined : await sourceArchive(join(webRoot, '..'));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="dsh-coopanion-source.zip"', 'Cache-Control': 'no-store' }); res.end(body); return;
      }
      const file = relative || 'index.html';
      if (!safePath(file)) { res.writeHead(404).end(); return; }
      const custom = file.match(/^packs\/([a-z0-9-]+)\/([a-f0-9]{64})\/(.+)$/);
      const bytes = custom ? await store.asset(custom[1]!, custom[2]!, custom[3]!) : await readFile(join(webRoot, file));
      const headers: Record<string, string> = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
      if (file.startsWith('upstream/') || custom) headers['Access-Control-Allow-Origin'] = '*';
      if (file === 'upstream/figure-frame.html') {
        headers['Content-Security-Policy'] = `default-src 'none'; script-src ${origin}${prefix}upstream/ ${origin}${prefix}packs/; img-src ${origin}${prefix}upstream/ ${origin}${prefix}packs/ data: blob:; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
      }
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof URIError;
      json({ ok: false, error: String((error as Error).message).slice(0, 400) }, missing ? 404 : 400);
    }
  });
  server.once('close', () => { void companions?.close(); });
  return server;
}
