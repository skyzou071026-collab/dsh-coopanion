const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

/** Aggregate session state only; unavailable adapters never imply an unlocked desktop. */
function initialLockState({ platform = process.platform, env = process.env, monitor, run = execFileSync } = {}) {
  // Native regression profiles explicitly control their desktop lifecycle.
  if (env.DSH_PET_TEST_NO_SANDBOX === '1') {
    const value = env.DSH_PET_TEST_INITIAL_LOCK_STATE ?? 'unlocked';
    if (value !== 'system') return ['locked', 'unlocked', 'unknown'].includes(value) ? value : 'unknown';
  }
  try {
    if (platform === 'darwin') {
      const value = run('/usr/bin/osascript', ['-l', 'JavaScript', join(__dirname, 'lifecycle-state-macos.jxa')],
        { encoding: 'utf8', timeout: 1500, maxBuffer: 128, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return ['locked', 'unlocked'].includes(value) ? value : 'unknown';
    }
    const value = monitor?.getSystemIdleState(1);
    return value === 'locked' ? 'locked' : ['active', 'idle'].includes(value) ? 'unlocked' : 'unknown';
  } catch { return 'unknown'; }
}
module.exports = { initialLockState };
