// Native, bounded resource observation; deliberately separate from CI correctness tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, platform, arch, release, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2), arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = resolve(arg('--checkout', '.')), output = resolve(arg('--output', 'artifacts/idle-resource.json'));
const mode = arg('--mode', 'baseline'), rounds = Number(arg('--rounds', '3')), seconds = Number(arg('--seconds', '60'));
assert.ok(['baseline', 'off', 'npc-day', 'npc-night', 'npc-controlled'].includes(mode));
assert.ok(Number.isInteger(rounds) && rounds >= 1 && seconds >= 10);
assert.ok(['darwin', 'linux'].includes(platform()), 'ps sampling currently supports macOS/Linux only');
const { ElectronBridge } = await import(pathToFileURL(join(root, 'dist/bridge.js')).href);
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-idle-resource-'));
process.env.DSH_PET_TEST_DATA_DIR = dataDir;
process.env.DSH_PET_TEST_NO_SANDBOX = '1';
const port = createServer(); port.listen(0, '127.0.0.1'); await once(port, 'listening');
process.env.DSH_PET_TEST_DEBUG_PORT = String(port.address().port); await new Promise(r => port.close(r));
const pause = ms => new Promise(r => setTimeout(r, ms));
const bridge = new ElectronBridge(); let browser;
const time = s => s.split(':').reduce((a, v) => a * 60 + Number(v), 0);
function sampleTree(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [id, parent, cpu, rss] = line.trim().split(/\s+/);
    return { pid: Number(id), ppid: Number(parent), cpuSeconds: time(cpu), rssKiB: Number(rss) };
  });
  const ids = new Set([pid]); let changed;
  do { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } } while (changed);
  return rows.filter(row => ids.has(row.pid));
}
const mean = a => a.reduce((s, n) => s + n, 0) / a.length;
const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
try {
  bridge.update({ mood: 'idle', active: false, text: '', sessionId: null, sessions: [], results: [] });
  await bridge.start({ size: 180, textScale: 1, locale: 'zh', roam: true, companionship: mode.startsWith('npc-') ? 'quiet' : 'off', notifications: true, bubbleDurationMs: 12000 });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.DSH_PET_TEST_DEBUG_PORT}`);
  const page = browser.contexts()[0].pages()[0];
  if (mode === 'npc-controlled') await page.route('**/npc-life.js', async route => {
    const response = await route.fetch(), source = await response.text();
    await route.fulfill({ response, body: source.replace('export function stepNpc(', 'function actualStepNpc(') + '\nexport function stepNpc(state, input) { return actualStepNpc(state, {...input, keyboard: "idle"}); }\n' });
  });
  if (mode !== 'baseline') {
    // Control local hour only; RAF, Date.now, physics and CPU all advance in real time.
    await page.addInitScript(hour => { const OriginalDate = Date; window.Date = class extends OriginalDate { getHours() { return hour; } }; let seed = 17; Math.random = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; }; }, mode.endsWith('night') ? 23 : 12);
    await page.reload();
  }
  await page.waitForSelector('#pet[data-host-ready=true][data-mode]');
  await page.mouse.move(0, 0);
  const display = await page.evaluate(() => window.dshPetBridge.testScreenPoint({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
  console.log(JSON.stringify({ phase: 'warmup', mode, sourceCommit, seconds: 20 }));
  await pause(20000);
  const pid = bridge.child.pid, samples = [], windows = [];
  let previous = sampleTree(pid), at = performance.now();
  for (let round = 0; round < rounds; round++) {
    const start = samples.length;
    for (let second = 0; second < seconds; second++) {
      await pause(1000);
      const tree = sampleTree(pid), now = performance.now(), elapsed = (now - at) / 1000;
      const cpuSeconds = tree.reduce((total, row) => { const old = previous.find(p => p.pid === row.pid); return total + (old ? Math.max(0, row.cpuSeconds - old.cpuSeconds) : 0); }, 0);
      const renderer = await page.evaluate(() => ({ mood: document.querySelector('#pet').dataset.mood, mode: document.querySelector('#pet').dataset.mode, companionship: document.querySelector('#pet').dataset.companionship, activity: document.querySelector('#pet').dataset.companionActivity, npcPhase: document.querySelector('#pet').dataset.npcPhase, npcReason: document.querySelector('#pet').dataset.npcReason, heapBytes: performance.memory?.usedJSHeapSize }));
      samples.push({ round: round + 1, elapsedSeconds: elapsed, cpuPercentOneCore: cpuSeconds / elapsed * 100, rssMiB: tree.reduce((n, p) => n + p.rssKiB, 0) / 1024, tree, renderer });
      assert.equal(renderer.mood, 'idle');
      previous = tree; at = now;
    }
    const window = samples.slice(start), entry = { round: round + 1, durationSeconds: window.reduce((s, p) => s + p.elapsedSeconds, 0), meanCpuPercentOneCore: mean(window.map(s => s.cpuPercentOneCore)), meanRssMiB: mean(window.map(s => s.rssMiB)), maxRssMiB: Math.max(...window.map(s => s.rssMiB)) };
    windows.push(entry); console.log(JSON.stringify(entry));
  }
  const report = { schema: 1, controlledKeyboardIdle: mode === 'npc-controlled', physicalTypingValidated: false, sourceCommit, measuredAt: new Date().toISOString(), mode, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version, electron: display.electron, display, size: 180, roam: true, warmupSeconds: 20, rounds, secondsPerRound: seconds,
    sources: Object.fromEntries(await Promise.all(['web/pet.js', 'web/companionship.js', 'web/companion-client.js', 'web/companion-touch.js', 'src/companion-store.ts', 'web/upstream/kit/body.js', 'dist/bridge.js'].map(async f => [f, createHash('sha256').update(await readFile(join(root, f))).digest('hex')]))),
    method: 'ps cumulative CPU deltas of Electron main and all descendants; 100% is one core; summed resident memory may count shared pages more than once; sampler process excluded; controlled local hour and fixed RNG seed 17 for off/day/night/companion modes; no frame acceleration; npc-controlled forces only the aggregate keyboard enum to idle, not physical input',
    windows, meanCpuPercentOneCore: mean(windows.map(w => w.meanCpuPercentOneCore)), meanRssMiB: mean(windows.map(w => w.meanRssMiB)), samples,
    limitations: 'Bounded same-machine observation, not long-term idle acceptance or other-platform evidence. Other desktop workloads and macOS GPU accounting can affect results.' };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally { await bridge.dispose(); await browser?.close(); await rm(dataDir, { recursive: true, force: true }); }
