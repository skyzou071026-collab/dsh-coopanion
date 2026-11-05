import { describe, it, expect } from 'vitest';
import { parseProcStat, processCpu, summarizeObservation, ResourceWindow, companionCoverage } from '../scripts/resource-observation.mjs';

describe('external resource evidence', () => {
  it('accepts the frozen 20 MiB boundary only after both full windows complete', () => {
    const samples = Array.from({ length: 1440 }, (_, i) => ({ atSeconds: (i + 1) * 5, elapsedSeconds: 5, rssMiB: i < 1080 ? 100 : 120, cpuPercentOneCore: 2 }));
    const report = summarizeObservation(samples, { seconds: 7200 });
    expect(report.status).toBe('pass');
    expect(report.rssDeltaMiB).toBe(20);
    expect(summarizeObservation(samples, { seconds: 7200, complete: false }).status).toBe('incomplete');
  });
  it('does not turn an interrupted run into a passing two-hour observation', () => {
    const samples = Array.from({ length: 360 }, (_, i) => ({ atSeconds: (i + 1) * 5, elapsedSeconds: 5, rssMiB: 100, cpuPercentOneCore: 1 }));
    expect(summarizeObservation(samples, { seconds: 7200 }).status).toBe('incomplete');
  });
  it('weights irregular samples by elapsed time and fails a sustained memory increase', () => {
    const samples = [{ atSeconds: 5, elapsedSeconds: 5, rssMiB: 100 }, { atSeconds: 30, elapsedSeconds: 25, rssMiB: 112 }, { atSeconds: 60, elapsedSeconds: 30, rssMiB: 140 }];
    const report = summarizeObservation(samples, { seconds: 60, windowSeconds: 30, maxGapSeconds: 30 });
    expect(report.firstWindow.mean).toBe(110);
    expect(report.rssDeltaMiB).toBe(30);
    expect(report.status).toBe('fail');
    expect(summarizeObservation(samples, { seconds: 60, windowSeconds: 30, maxGapSeconds: 10 }).status).toBe('incomplete');
  });
  it('does not reuse a PID lifetime or charge pre-interval CPU of a new process', () => {
    const previous = [{ pid: 1, startTicks: 10, cpuTicks: 100 }, { pid: 2, startTicks: 20, cpuTicks: 100 }];
    const current = [{ pid: 1, startTicks: 10, cpuTicks: 150 }, { pid: 2, startTicks: 30, cpuTicks: 1000 }, { pid: 3, startTicks: 40, cpuTicks: 500 }];
    expect(processCpu(previous, current, 5, 100)).toBe(10);
  });
  it('handles Linux process names containing spaces and closing parentheses', () => {
    const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[11] = '50'; fields[12] = '20'; fields[19] = '900'; fields[21] = '256';
    expect(parseProcStat('12 (electron (worker)) ' + fields.join(' '))).toEqual({ pid: 12, ppid: 1, startTicks: 900, cpuTicks: 70, rssMiB: 1 });
    expect(() => parseProcStat('12 (broken) S')).toThrow();
  });
});

it('bounds seven-day sampler memory and keeps the largest gap outside retained windows', () => {
  const window = new ResourceWindow(30);
  for (let second = 5; second <= 604800; second += 5) window.add({ atSeconds: second, elapsedSeconds: second === 500 ? 30 : 5, rssMiB: 100, cpuPercentOneCore: 2 });
  expect(window.first.length).toBeLessThanOrEqual(7);
  expect(window.last.length).toBeLessThanOrEqual(8);
  expect(window.finish(604800, { maxGapSeconds: 15 }).status).toBe('incomplete');
  expect(window.finish(604800, { maxGapSeconds: 30 }).meanCpuPercentOneCore).toBeCloseTo(2, 2);
});

it('separates NPC cycle coverage from legacy routines and cannot accept stationary or cross-contract counters', () => {
  const renderer = { npc: { keyboard: 'unknown' }, counts: { routines: { observe: 3, play: 3, rest: 3 }, invitationsShown: 1 } }, store = { invitations: 1 };
  expect(companionCoverage(renderer, store, ['home', 'yield']).daily).toBe(false);
  expect(companionCoverage(renderer, store, ['home', 'outbound', 'observe', 'return']).daily).toBe(true);
  expect(companionCoverage({ ...renderer, npc: undefined }, store).daily).toBe(true);
  expect(companionCoverage(renderer, { invitations: 2 }, ['home', 'outbound', 'observe', 'return']).invitation).toBe(false);
  expect(companionCoverage(renderer, store, ['private input']).observedPhases).toEqual([]);
});
