import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export function parseProcStat(raw, pageSize = 4096) {
  const end = raw.lastIndexOf(')');
  if (end < 0) throw new Error('Invalid /proc stat');
  const pid = Number(raw.slice(0, raw.indexOf(' ')));
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  const value = { pid, ppid: Number(fields[1]), startTicks: Number(fields[19]), cpuTicks: Number(fields[11]) + Number(fields[12]), rssMiB: Number(fields[21]) * pageSize / 1048576 };
  if (!Number.isSafeInteger(value.pid) || fields.length < 22 || Object.values(value).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid /proc stat values');
  return value;
}

export async function linuxSnapshot(rootPid) {
  const pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
  const entries = (await readdir('/proc')).filter(p => /^\d+$/.test(p));
  const rows = (await Promise.all(entries.map(async pid => {
    try {
      const row = parseProcStat(await readFile('/proc/' + pid + '/stat', 'utf8'), pageSize);
      row.command = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).replaceAll('\0', ' ').trim();
      return row;
    } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null; throw error; }
  }))).filter(Boolean);
  if (!rows.some(r => r.pid === rootPid)) throw new Error('Observed root process exited');
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter(r => ids.has(r.pid));
}

export function processCpu(previous, current, elapsedSeconds, ticksPerSecond) {
  if (!(elapsedSeconds > 0) || !(ticksPerSecond > 0)) throw new Error('Invalid sampling interval');
  const old = new Map(previous.map(row => [row.pid, row]));
  let ticks = 0;
  for (const row of current) {
    const before = old.get(row.pid);
    // PID reuse is a new lifetime. Pre-interval CPU cannot be attributed to this interval.
    if (before?.startTicks === row.startTicks) ticks += Math.max(0, row.cpuTicks - before.cpuTicks);
  }
  return ticks / ticksPerSecond / elapsedSeconds * 100;
}

export async function linuxEnvironment() {
  const [stat, memory, pressure, load] = await Promise.all([
    readFile('/proc/stat', 'utf8'), readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/pressure/memory', 'utf8'), readFile('/proc/loadavg', 'utf8'),
  ]);
  const cpu = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const kib = name => Number(memory.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1] ?? 0);
  return {
    cpuTotalTicks: cpu.slice(0, 8).reduce((a, b) => a + b, 0), stealTicks: cpu[7],
    availableMiB: kib('MemAvailable') / 1024, swapUsedMiB: (kib('SwapTotal') - kib('SwapFree')) / 1024,
    memoryPressure: pressure.trim(), loadAverage: load.trim().split(/\s+/).slice(0, 3).map(Number),
  };
}

function weightedMean(samples, start, end, field) {
  let sum = 0, coveredSeconds = 0;
  for (const sample of samples) {
    const overlap = Math.max(0, Math.min(end, sample.atSeconds) - Math.max(start, sample.atSeconds - sample.elapsedSeconds));
    if (!Number.isFinite(sample[field])) continue;
    sum += sample[field] * overlap; coveredSeconds += overlap;
  }
  return { mean: coveredSeconds ? sum / coveredSeconds : null, coveredSeconds };
}

/** Fixed wall-time windows, never a count of samples or an incomplete run's last samples. */
export function summarizeObservation(samples, { seconds, windowSeconds = 1800, maxGapSeconds = 20, rssBudgetMiB = 20, complete = true } = {}) {
  if (!(seconds >= windowSeconds * 2) || !(windowSeconds > 0)) throw new Error('Observation requires two complete windows');
  const valid = samples.length > 0 && samples.every((s, i) => Number.isFinite(s.atSeconds) && s.elapsedSeconds > 0 && Number.isFinite(s.rssMiB) && (i === 0 || s.atSeconds > samples[i - 1].atSeconds));
  if (!valid) return { status: 'incomplete', reason: 'invalid-or-missing-samples' };
  const first = weightedMean(samples, 0, windowSeconds, 'rssMiB');
  const last = weightedMean(samples, seconds - windowSeconds, seconds, 'rssMiB');
  const cpu = weightedMean(samples, 0, seconds, 'cpuPercentOneCore');
  const duration = samples.at(-1).atSeconds, largestGap = Math.max(...samples.map(s => s.elapsedSeconds));
  const covered = first.coveredSeconds >= windowSeconds * .99 && last.coveredSeconds >= windowSeconds * .99;
  const enough = complete && duration >= seconds && covered && largestGap <= maxGapSeconds;
  const delta = first.mean === null || last.mean === null ? null : last.mean - first.mean;
  return {
    status: !enough ? 'incomplete' : delta <= rssBudgetMiB ? 'pass' : 'fail',
    durationSeconds: duration, requestedSeconds: seconds, windowSeconds, largestGapSeconds: largestGap,
    firstWindow: first, lastWindow: last, rssDeltaMiB: delta, rssBudgetMiB, meanCpuPercentOneCore: cpu.mean,
    maxRssMiB: Math.max(...samples.map(s => s.rssMiB)),
    scope: 'RSS stability only; queues, archive bounds, rendering coverage and environment require separate checks',
  };
}

/** Bounded first/last windows; raw history belongs to the external output file. */
export class ResourceWindow {
  constructor(windowSeconds = 1800) { this.windowSeconds = windowSeconds; this.first = []; this.last = []; this.count = 0; this.maxGap = 0; this.cpuArea = 0; this.duration = 0; this.maxRss = 0; }
  add(sample) {
    const value = { atSeconds: sample.atSeconds, elapsedSeconds: sample.elapsedSeconds, rssMiB: sample.rssMiB, cpuPercentOneCore: sample.cpuPercentOneCore };
    if (value.atSeconds - value.elapsedSeconds < this.windowSeconds) this.first.push(value);
    this.last.push(value);
    while (this.last.length > 1 && this.last[1].atSeconds <= value.atSeconds - this.windowSeconds) this.last.shift();
    this.count++; this.maxGap = Math.max(this.maxGap, value.elapsedSeconds); this.duration = value.atSeconds; this.maxRss = Math.max(this.maxRss, value.rssMiB);
    this.cpuArea += value.cpuPercentOneCore * value.elapsedSeconds;
  }
  finish(seconds, { complete = true, maxGapSeconds = 30 } = {}) {
    if (seconds < this.windowSeconds * 2 || !this.count) return { status: 'incomplete', durationSeconds: this.duration, samples: this.count, reason: 'insufficient-window-duration' };
    const samples = [...new Map([...this.first, ...this.last].map(s => [s.atSeconds, s])).values()].sort((a, b) => a.atSeconds - b.atSeconds);
    const result = summarizeObservation(samples, { seconds, windowSeconds: this.windowSeconds, maxGapSeconds, complete: complete && this.maxGap <= maxGapSeconds });
    return { ...result, largestGapSeconds: this.maxGap, maxRssMiB: this.maxRss, meanCpuPercentOneCore: this.cpuArea / this.duration, samples: this.count };
  }
}

/** Coverage follows the renderer contract; legacy routines never stand in for an NPC cycle. */
export function companionCoverage(renderer, store, phases = []) {
  const observedPhases = [...new Set(phases.filter(p => ['home', 'prepare', 'outbound', 'observe', 'return', 'yield', 'resume'].includes(p)))].sort();
  const routines = !!renderer && ['observe', 'play', 'rest'].every(kind => renderer.counts.routines[kind] > 0);
  const npc = !!renderer?.npc && ['home', 'outbound', 'observe', 'return'].every(p => observedPhases.includes(p));
  return { kind: renderer?.npc ? 'npc' : 'routines', routines, npc, observedPhases, daily: renderer?.npc ? npc : routines,
    invitation: !!renderer && renderer.counts.invitationsShown >= 1 && renderer.counts.invitationsShown <= 2 && store?.invitations === renderer.counts.invitationsShown };
}
