/** Passive sampler: local diagnostic socket plus OS process metrics. No Electron/CDP dependency. */
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, writeFile, rename, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listDiagnostics, readDiagnostics } from './diagnostics-client.mjs';
import { linuxSnapshot, linuxEnvironment, processCpu, ResourceWindow, companionCoverage } from './resource-observation.mjs';

const { values: args } = parseArgs({ options: {
  registry: { type: 'string' }, instance: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string' },
  until: { type: 'string' }, interval: { type: 'string' }, window: { type: 'string' }, 'max-mib': { type: 'string' },
  'expect-version': { type: 'string' }, 'expect-product-digest': { type: 'string' },
  strict: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
} });
const registry = resolve(args.registry ?? join(homedir(), '.dsh-coopanion', 'diagnostics'));
if (args.list) {
  console.log(JSON.stringify((await listDiagnostics(registry)).map(({ instance, pid, version, startedAt }) => ({ instance, pid, version, startedAt })), null, 2));
} else {
  if (!args.output) throw new Error('--output is required');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('OS process sampling currently supports Linux/macOS');
  const seconds = Number(args.seconds ?? 604800), interval = Number(args.interval ?? 10), windowSeconds = Number(args.window ?? 1800);
  const deadline = args.until === undefined ? null : Date.parse(args.until);
  if (deadline !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(args.until) || !Number.isFinite(deadline) || deadline <= Date.now())) throw new Error('--until requires a future ISO timestamp with timezone');
  const maxBytes = Number(args['max-mib'] ?? 128) * 1048576;
  if (![seconds, interval, windowSeconds, maxBytes].every(Number.isFinite) || seconds < 1 || interval < 1 || interval > 60 || windowSeconds < 10 || maxBytes < 1048576) throw new Error('Invalid sampling limits');
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true }); await mkdir(output);
  const samples = await open(join(output, 'samples.ndjson'), 'wx'), events = await open(join(output, 'events.ndjson'), 'wx');
  const started = performance.now(), startedAt = new Date().toISOString();
  const scriptNames = ['sample-companion.mjs', 'diagnostics-client.mjs', 'resource-observation.mjs'];
  const collectorHashes = Object.fromEntries(await Promise.all(scriptNames.map(async name => [name, createHash('sha256').update(await readFile(fileURLToPath(new URL('./' + name, import.meta.url)))).digest('hex')])));
  const metadata = { schema: 1, startedAt, platform: process.platform, arch: process.arch, node: process.version, requestedSeconds: seconds, intervalSeconds: interval, windowSeconds, maxBytes, wallDeadline: deadline === null ? null : new Date(deadline).toISOString(), strict: args.strict, collectorHashes,
    method: 'External OS process-tree RSS/CPU and authenticated read-only local socket. No UI input, screen capture, CDP or clock changes. RSS may double-count shared pages; CPU can miss exited/new children.',
  };
  await writeFile(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  let stop = false, reason = 'duration', rawBytes = 0, count = 0, current, previousTree, previousAt, previousWall;
  let lastSnapshot, maxPending = 0, maxStorePending = 0, errors = 0, firstError, maxSteal = 0, maxSwap = 0, previousEnvironment;
  const segments = [];
  const signal = () => { stop = true; reason = 'signal'; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const event = async value => { const line = JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'; await events.write(line); console.log(line.trim()); };
  const checkpoint = async value => { const path = join(output, 'progress.json'); await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); await rename(path + '.tmp', path); };
  const pause = () => new Promise(r => setTimeout(r, Math.max(1, Math.min(interval * 1000, deadline === null ? Infinity : deadline - Date.now()))));
  const ticks = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : 100;
  async function tree(pid) {
    if (process.platform === 'linux') return linuxSnapshot(pid);
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,lstart='], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
    const cpuTime = raw => {
      const parts = raw.split('-'), days = parts.length === 2 ? Number(parts.shift()) : 0;
      return (days * 86400 + parts[0].split(':').reduce((sum, value) => sum * 60 + Number(value), 0)) * 100;
    };
    const rows = output.trim().split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) throw new Error('Cannot parse process metrics');
      return { pid: Number(match[1]), ppid: Number(match[2]), cpuTicks: cpuTime(match[3]), rssMiB: Number(match[4]) / 1024, startTicks: match[5] };
    });
    if (!rows.some(row => row.pid === pid)) throw new Error('Observed root exited');
    const ids = new Set([pid]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
    return rows.filter(row => ids.has(row.pid));
  }
  const finishSegment = complete => {
    if (!current) return;
    const duration = (previousAt - current.at) / 1000;
    segments.push({ instance: current.instance, session: current.session, version: current.version, build: current.build, startedAt: current.startedAt, reason: complete ? 'duration' : reason,
      npcPhases: [...current.npcPhases].sort(), resource: current.window.finish(complete ? seconds : duration, { complete, maxGapSeconds: interval * 3 }), lastSnapshot });
    current = undefined; previousTree = undefined; previousAt = undefined; previousWall = undefined;
  };
  let checkpointAt = 60, unavailable = false, failure = null, targetInstance = args.instance;
  try {
    while (!stop && (performance.now() - started) / 1000 < seconds + Math.max(interval, 30)) {
      if (deadline !== null && Date.now() >= deadline) { reason = 'deadline'; break; }
      const candidates = (await listDiagnostics(registry)).filter(endpoint => !targetInstance || endpoint.instance === targetInstance);
      if (candidates.length > 1) throw new Error('Multiple diagnostic instances: select one with --instance');
      if (!candidates.length) {
        if (args.strict) throw new Error('Diagnostic endpoint unavailable');
        if (!unavailable) { reason = 'unavailable'; finishSegment(false); await event({ type: 'unavailable' }); unavailable = true; }
        await pause(); continue;
      }
      const endpoint = candidates[0];
      let snapshot;
      try { snapshot = await readDiagnostics(endpoint); }
      catch (error) {
        if (args.strict) throw error;
        if (!unavailable) { reason = 'unavailable'; finishSegment(false); await event({ type: 'unavailable', reason: 'read-failed' }); unavailable = true; }
        await pause(); continue;
      }
      if (deadline !== null && Date.now() >= deadline) { reason = 'deadline'; break; }
      if (args['expect-version'] && snapshot.version !== args['expect-version']) throw new Error('Candidate version mismatch');
      if (args['expect-product-digest'] && snapshot.build.productDigest !== args['expect-product-digest']) throw new Error('Candidate product digest mismatch');
      targetInstance ??= snapshot.instance;
      const rows = await tree(endpoint.pid), now = performance.now(), wall = Date.now();
      const env = process.platform === 'linux' ? await linuxEnvironment() : null;
      if (unavailable) { await event({ type: 'available' }); unavailable = false; }
      const gap = previousAt !== undefined && ((now - previousAt) / 1000 > interval * 3 || (wall - previousWall) / 1000 > interval * 3);
      if (current && (current.session !== snapshot.session || current.version !== snapshot.version || current.build.productDigest !== snapshot.build.productDigest || gap)) {
        if (args.strict) throw new Error('Process/diagnostic lifetime changed or sampling gap');
        reason = gap ? 'gap' : 'restart'; finishSegment(false);
      }
      if (!current) {
        if (segments.length >= 64) throw new Error('Segment limit reached');
        current = { instance: snapshot.instance, session: snapshot.session, version: snapshot.version, build: snapshot.build, startedAt: snapshot.measuredAt, at: now, npcPhases: new Set(), window: new ResourceWindow(windowSeconds) };
        lastSnapshot = snapshot; previousTree = rows; previousAt = now; previousWall = wall; previousEnvironment = env;
        await event({ type: 'segment-start', instance: snapshot.instance, pid: snapshot.pid, version: snapshot.version, productDigest: snapshot.build.productDigest });
      } else {
        const elapsedSeconds = (now - previousAt) / 1000, atSeconds = (now - current.at) / 1000;
        const totalTicks = env ? env.cpuTotalTicks - previousEnvironment.cpuTotalTicks : 0;
        const steal = env && totalTicks > 0 ? (env.stealTicks - previousEnvironment.stealTicks) / totalTicks * 100 : null;
        maxSteal = Math.max(maxSteal, steal ?? 0); maxSwap = Math.max(maxSwap, env?.swapUsedMiB ?? 0);
        const sample = { time: snapshot.measuredAt, atSeconds, elapsedSeconds, globalAtSeconds: (now - started) / 1000,
          rssMiB: rows.reduce((sum, row) => sum + row.rssMiB, 0), cpuPercentOneCore: processCpu(previousTree, rows, elapsedSeconds, ticks),
          processTree: rows.map(({ command, ...row }) => row), diagnostic: snapshot, environment: env ? { ...env, stealPercent: steal } : null,
        };
        const line = JSON.stringify(sample) + '\n';
        if (rawBytes + Buffer.byteLength(line) > maxBytes) { reason = 'size-limit'; throw new Error('Raw sample size limit reached'); }
        await samples.write(line); rawBytes += Buffer.byteLength(line); count++; current.window.add(sample); lastSnapshot = snapshot;
        const data = snapshot.value, renderer = data.renderer;
        if (renderer?.npc) current.npcPhases.add(renderer.npc.phase);
        maxPending = Math.max(maxPending, renderer?.queues.carePending ?? 0); maxStorePending = Math.max(maxStorePending, data.store.pending);
        if (args.strict) {
          if (!renderer || renderer.mode !== 'interactive' || renderer.hidden || renderer.hour < 7 || renderer.hour >= 22 || renderer.mood !== 'idle' || !data.runtime.visible || data.runtime.suspended) throw new Error('Controlled daytime idle scenario is unavailable');
          if (renderer.npc && renderer.npc.keyboard !== 'idle') throw new Error('Controlled NPC keyboard perception is unavailable');
          if (renderer.careUnavailable || data.store.failed || data.store.bytes > 262144 || data.store.recentCount > 128 || data.store.characterCount > 256 || data.store.invitations > 2) throw new Error('Companion store bounds failed');
        }
        if (sample.globalAtSeconds >= checkpointAt) {
          await checkpoint({ measuredAt: snapshot.measuredAt, elapsedSeconds: sample.globalAtSeconds, requestedSeconds: seconds, samples: count, rawBytes, lastSample: sample });
          await event({ type: 'progress', elapsedSeconds: sample.globalAtSeconds, rssMiB: sample.rssMiB, pending: renderer?.queues.carePending, routines: renderer?.counts.routines, npc: renderer?.npc, invitationsShown: renderer?.counts.invitationsShown });
          checkpointAt += 60;
        }
        previousTree = rows; previousAt = now; previousWall = wall; previousEnvironment = env;
        if (atSeconds >= seconds) { reason = 'duration'; break; }
      }
      await pause();
    }
  } catch (error) { errors++; firstError = String(error.message ?? error); reason = reason === 'size-limit' ? reason : 'error'; failure = firstError; }
  finally {
    const complete = reason === 'duration' && current?.window.duration >= seconds && !stop;
    finishSegment(complete);
    const last = segments.at(-1), renderer = lastSnapshot?.value.renderer, store = lastSnapshot?.value.store;
    const coverage = companionCoverage(renderer, store, last?.npcPhases ?? []);
    const full = complete && segments.length === 1 && seconds >= 7200 && windowSeconds >= 1800;
    const bounds = { maxPendingRequests: maxPending, maxStorePending, requestsDrained: renderer?.queues.carePending === 0 && store?.pending === 0 };
    const strictPass = last?.resource.status === 'pass' && bounds.requestsDrained && (!full || coverage.daily && coverage.invitation);
    const summary = { schema: 1, startedAt, endedAt: new Date().toISOString(), reason, status: failure ? 'incomplete' : args.strict ? !complete ? 'incomplete' : strictPass ? 'pass' : 'fail' : 'recorded',
      fullTwoHourObservation: full, samples: count, rawBytes, errors, firstError, bounds, coverage, environment: { maxStealPercent: maxSteal, maxSwapUsedMiB: maxSwap }, segments,
      limitations: 'Passive local observation; subjective experience, physical delivery, GPU power and other platforms require separate evidence. Diagnostic counters cover finite known queues, not all timers/objects.',
    };
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    await event({ type: 'finished', status: summary.status, reason, fullTwoHourObservation: full, samples: count });
    await samples.close(); await events.close(); process.off('SIGINT', signal); process.off('SIGTERM', signal);
    if (failure || args.strict && summary.status !== 'pass') process.exitCode = 1;
  }
}
