import { readdir, readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function listDiagnostics(registry) {
  let names;
  try { names = await readdir(registry); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = names.filter(name => /^[a-f0-9]{20}-\d+\.json$/.test(name));
  if (files.length > 256) throw new Error('Too many diagnostic descriptors');
  const endpoints = [];
  for (const name of files) {
    for (let attempt = 0; ; attempt++) {
      try {
        const path = join(registry, name), info = await stat(path);
        if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new Error('Unsafe diagnostic descriptor permissions');
        if (info.size > 4096) throw new Error('Oversized diagnostic descriptor');
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (value.schema !== 1 || !/^[a-f0-9]{20}$/.test(value.instance) || !/^[a-f0-9]{32}$/.test(value.session) || !/^[a-f0-9]{64}$/.test(value.token) ||
            !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.socketPath !== 'string' || value.socketPath.length > 256 ||
            !/^\d+\.\d+\.\d+$/.test(value.version) || !Number.isFinite(Date.parse(value.startedAt))) throw new Error('Invalid diagnostic descriptor');
        try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; if (error.code !== 'EPERM') throw error; }
        endpoints.push(value);
        break;
      } catch (error) {
        if (error.code === 'ENOENT') break;
        // Windows may deny opening a file that is being withdrawn after stat.
        if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= 2) throw error;
        await delay(50);
      }
    }
  }
  return endpoints;
}
const count = value => {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('Invalid diagnostic number');
  return value;
};
const pickCounts = (value, keys) => Object.fromEntries(keys.map(key => [key, count(value?.[key])]));
/** Construct a whitelist: no endpoint credentials, text, paths or request/session identities. */
export function sanitizeSnapshot(raw, endpoint) {
  if (raw.schema !== 1 || raw.instance !== endpoint.instance || raw.session !== endpoint.session || raw.pid !== endpoint.pid || raw.version !== endpoint.version || raw.startedAt !== endpoint.startedAt || !Number.isFinite(Date.parse(raw.measuredAt))) throw new Error('Diagnostic identity mismatch');
  const data = raw.value, renderer = data?.renderer;
  if (!data?.runtime || typeof data.runtime.visible !== 'boolean' || typeof data.runtime.suspended !== 'boolean' || !data.store) throw new Error('Invalid diagnostic state');
  let cleanRenderer = null;
  if (renderer !== null) {
    if (!['off', 'quiet', 'interactive'].includes(renderer?.mode) || !['idle', 'observe', 'play', 'rest', 'greeting'].includes(renderer.activity) ||
        !['none', 'pending', 'shown'].includes(renderer.invitation) || typeof renderer.mood !== 'string' || !/^[a-z-]{1,24}$/.test(renderer.mood) || typeof renderer.hidden !== 'boolean' || typeof renderer.careUnavailable !== 'boolean' ||
        !Number.isInteger(renderer.hour) || renderer.hour < 0 || renderer.hour > 23) throw new Error('Invalid renderer diagnostics');
    cleanRenderer = { mode: renderer.mode, activity: renderer.activity, invitation: renderer.invitation, mood: renderer.mood, careUnavailable: renderer.careUnavailable, hidden: renderer.hidden, hour: renderer.hour,
      queues: pickCounts(renderer.queues, ['carePending', 'pendingInteractions', 'composerSessions', 'chatTimers', 'snoozing', 'shownResults', 'acknowledgedResults']),
      counts: { routines: pickCounts(renderer.counts?.routines, ['observe', 'play', 'rest', 'greeting']), ...pickCounts(renderer.counts, ['invitationsShown', 'invitationsExpired', 'invitationsAccepted', 'invitationsLater', 'invitationsQuiet']) },
      heapBytes: count(renderer.heapBytes), nodes: count(renderer.nodes),
    };
  }
  if (cleanRenderer && renderer.npc) {
    const n = renderer.npc;
    if (!['home', 'prepare', 'outbound', 'observe', 'return', 'yield', 'resume'].includes(n.phase) || !['none', 'disabled', 'input', 'unknown', 'pointer', 'work', 'user', 'lifecycle', 'geometry', 'capability'].includes(n.reason) || !['active', 'idle', 'unknown'].includes(n.keyboard) || typeof n.targetValid !== 'boolean' || typeof n.compact !== 'boolean') throw new Error('Invalid NPC diagnostics');
    if (n.keyboardBackend !== undefined && !['macos', 'windows', 'x11', 'none'].includes(n.keyboardBackend)) throw new Error('Invalid keyboard backend');
    if (n.keyboardStatus !== undefined && !['disabled', 'starting', 'available', 'unsupported-platform', 'unsupported-session', 'missing-dependency', 'failed', 'stale', 'unavailable', 'protocol-error'].includes(n.keyboardStatus)) throw new Error('Invalid keyboard status');
    cleanRenderer.npc = { phase: n.phase, reason: n.reason, keyboard: n.keyboard, targetValid: n.targetValid, compact: n.compact, ...(n.keyboardBackend === undefined ? {} : { keyboardBackend: n.keyboardBackend }), ...(n.keyboardStatus === undefined ? {} : { keyboardStatus: n.keyboardStatus }) };
  }
  const runtime = { visible: data.runtime.visible, suspended: data.runtime.suspended, generation: count(data.runtime.generation) };
  for (const key of ['screenLocked', 'systemAsleep', 'lockStateKnown']) {
    if (data.runtime[key] !== undefined) {
      if (typeof data.runtime[key] !== 'boolean') throw new Error('Invalid lifecycle state');
      runtime[key] = data.runtime[key];
    }
  }
  if (data.runtime.lifecycle !== undefined) runtime.lifecycle = pickCounts(data.runtime.lifecycle, ['locks', 'unlocks', 'suspends', 'resumes']);
  const productDigest = raw.build?.productDigest;
  if (!/^[a-f0-9]{64}$/.test(productDigest) || !(raw.build.commit === null || /^[a-f0-9]{40}$/.test(raw.build.commit)) || ![true, false, null].includes(raw.build.dirty)) throw new Error('Invalid build identity');
  return { schema: 1, instance: raw.instance, session: raw.session, pid: raw.pid, startedAt: raw.startedAt, measuredAt: raw.measuredAt, version: raw.version,
    build: { schema: 1, commit: raw.build.commit, dirty: raw.build.dirty, productDigest },
    value: { runtime,
      store: { initialized: data.store.initialized === true, writable: data.store.writable === true, failed: data.store.failed === true,
        ...pickCounts(data.store, ['bytes', 'revision', 'recentCount', 'characterCount', 'invitations', 'pending']) }, renderer: cleanRenderer },
  };
}
export function readDiagnostics(endpoint, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: endpoint.socketPath, path: '/snapshot', method: 'GET', agent: false, headers: { Authorization: 'Bearer ' + endpoint.token } });
    const timer = setTimeout(() => req.destroy(new Error('Diagnostic read timeout')), timeoutMs);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.once('response', response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32768) req.destroy(new Error('Oversized diagnostic response')); else chunks.push(chunk); });
      response.once('aborted', () => { clearTimeout(timer); reject(new Error('Diagnostic response aborted')); });
      response.once('error', error => { clearTimeout(timer); reject(error); });
      response.once('end', () => {
        clearTimeout(timer);
        try { if (response.statusCode !== 200) throw new Error('Diagnostic endpoint returned ' + response.statusCode); resolve(sanitizeSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')), endpoint)); }
        catch (error) { reject(error); }
      });
    });
    req.end();
  });
}
