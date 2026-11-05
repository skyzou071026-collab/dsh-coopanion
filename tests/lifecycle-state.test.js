import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { initialLockState } = createRequire(import.meta.url)('../desktop/lifecycle-state.cjs');
it('reads only the bounded macOS session enum and treats invalid, missing or failed replies as unknown', () => {
  for (const value of ['locked', 'unlocked']) expect(initialLockState({ platform: 'darwin', env: {}, run: (file, args, options) => {
    expect(file).toBe('/usr/bin/osascript'); expect(args[0]).toBe('-l'); expect(args[1]).toBe('JavaScript');
    expect(args[2]).toMatch(/lifecycle-state-macos\.jxa$/); expect(options.timeout).toBe(1500); expect(options.maxBuffer).toBe(128);
    return value + '\n';
  } })).toBe(value);
  for (const value of ['', 'unknown', 'private session text']) expect(initialLockState({ platform: 'darwin', env: {}, run: () => value })).toBe('unknown');
  expect(initialLockState({ platform: 'darwin', env: {}, run: () => { throw Error('unavailable'); } })).toBe('unknown');
});
it.each(['win32', 'linux'])('%s initializes from the native idle-state API without assuming unknown is unlocked', platform => {
  for (const [value, expected] of [['locked', 'locked'], ['idle', 'unlocked'], ['active', 'unlocked'], ['unknown', 'unknown']]) {
    expect(initialLockState({ platform, env: {}, monitor: { getSystemIdleState: threshold => { expect(threshold).toBe(1); return value; } } })).toBe(expected);
  }
  expect(initialLockState({ platform, env: {}, monitor: { getSystemIdleState() { throw Error('unsupported'); } } })).toBe('unknown');
});
it('isolated lifecycle controls require the explicit native test mode', () => {
  expect(initialLockState({ platform: 'darwin', env: { DSH_PET_TEST_INITIAL_LOCK_STATE: 'unlocked' }, run: () => 'locked' })).toBe('locked');
  expect(initialLockState({ env: { DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_INITIAL_LOCK_STATE: 'locked' } })).toBe('locked');
  expect(initialLockState({ env: { DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_INITIAL_LOCK_STATE: 'invalid' } })).toBe('unknown');
  expect(initialLockState({ platform: 'darwin', env: { DSH_PET_TEST_NO_SANDBOX: '1', DSH_PET_TEST_INITIAL_LOCK_STATE: 'system' }, run: () => 'locked' })).toBe('locked');
});

it('the macOS adapter uses the CGSession.h dictionary keys and rejects missing or malformed flags', () => {
  const source = readFileSync(new URL('../desktop/lifecycle-state-macos.jxa', import.meta.url), 'utf8');
  for (const [flags, expected] of [
    [{ CGSSessionScreenIsLocked: true }, 'locked'],
    [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }, 'unlocked'],
    [{ CGSSessionScreenIsLocked: false, kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }, 'unlocked'],
    [{}, 'unknown'],
    // The API macro name is not its dictionary key (CGSession.h).
    [{ kCGSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }, 'unknown'],
    [{ kCGSSessionOnConsoleKey: false, kCGSessionLoginDoneKey: true }, 'unknown'],
    [{ CGSSessionScreenIsLocked: 'invalid', kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }, 'unknown'],
  ]) {
    const accessed = [], dollar = value => value;
    dollar.CGSessionCopyCurrentDictionary = () => ({});
    const ObjC = { import() {}, unwrap: value => value, castRefToObject: () => ({ objectForKey(key) { accessed.push(key); return flags[key]; } }) };
    expect(runInNewContext(source, { ObjC, $: dollar })).toBe(expected);
    expect(accessed.every(key => ['CGSSessionScreenIsLocked', 'kCGSSessionOnConsoleKey', 'kCGSessionLoginDoneKey'].includes(key))).toBe(true);
  }
});
