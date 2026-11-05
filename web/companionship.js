/** Local decisions only. The owner of persistent state authorizes invitation budgets and growth. */
export const COMPANIONSHIP_MODES = ['off', 'quiet', 'interactive'];
export const companionshipMode = value => COMPANIONSHIP_MODES.includes(value) ? value : 'off';
const entropy = random => { const n = random(); return Number.isFinite(n) ? Math.min(.999999, Math.max(0, n)) : .5; };
const invitationWait = random => 1800000 + entropy(random) * 1800000;
const recipes = {
  play: [[['happy', 1000], ['dance', 3500], ['neutral', 200]], [['happy', 1000], ['nod', 1000], ['neutral', 200]]],
};
export const initialCompanionship = () => ({ mode: 'off', period: null, lastAt: null, inviteAt: null, invitation: null, invitationUntil: null, active: null, blocked: true });
const recipe = (kind, words) => recipes[kind]?.find(steps => words.includes('neutral') && steps.every(([word]) => words.includes(word)));

/** Intent and release are consumed by the same caller; owned body motion is not an external blocker. */
export function stepCompanionship(state, input, random = Math.random) {
  const { now, hour, words = [], occupied = false, automatic = true, eligible = false, unlocked = false, action } = input;
  const mode = companionshipMode(input.mode), period = Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour >= 7 && hour < 22 ? 'day' : 'night' : null;
  const next = { ...state, mode, period, lastAt: now };
  const output = { state: next };
  const reset = () => { output.release = !!state.active; output.hideInvitation = !!state.invitation; next.active = null; next.invitation = null; next.invitationUntil = null; next.inviteAt = now + 1800000; };
  if (mode === 'off' || !Number.isFinite(now) || !period) { output.release = !!state.active; output.hideInvitation = !!state.invitation; output.state = initialCompanionship(); return output; }
  const discontinuity = state.lastAt !== null && (now < state.lastAt || now - state.lastAt > 10000);
  if (mode !== state.mode || period !== state.period || discontinuity) { reset(); next.blocked = occupied; return output; }
  if (occupied) { output.release = !!state.active; output.hideInvitation = !!state.invitation; next.active = null; next.invitation = null; next.invitationUntil = null; next.inviteAt = null; next.blocked = true; return output; }
  if (state.blocked) { reset(); next.blocked = false; if (action !== 'play') return output; }
  if (action === 'play') {
    const steps = recipe('play', words);
    reset();
    if (steps) { next.active = { kind: 'play', steps, index: 0, dueAt: now + steps[0][1], manual: true, deadline: now + 20000 }; output.word = steps[0][0]; }
    return output;
  }
  if (action === 'reserved') {
    if (state.invitation === 'pending' && automatic && mode === 'interactive' && period === 'day') {
      next.invitation = 'shown'; next.invitationUntil = now + 10000;
      const steps = words.includes('wave') ? [['wave', 2000], ...(unlocked && words.includes('love') ? [['love', 1200]] : []), ['neutral', 200]] : null;
      if (steps && words.includes('neutral')) { next.active = { kind: 'greeting', steps, index: 0, dueAt: now + steps[0][1], manual: false, deadline: now + 20000 }; output.word = steps[0][0]; }
      output.showInvitation = true;
    }
    return output;
  }
  if (['dismiss', 'later', 'quiet', 'failed'].includes(action)) {
    reset(); next.inviteAt = now + (action === 'later' ? 3600000 : invitationWait(random)); return output;
  }
  if (state.invitation === 'shown' && now >= state.invitationUntil || state.invitation && (!automatic || mode !== 'interactive' || period === 'night')) {
    reset(); next.inviteAt = now + invitationWait(random); return output;
  }
  if (state.active) {
    if (now >= state.active.deadline) { reset(); return output; }
    if (!automatic && !state.active.manual) { reset(); return output; }
    if (now < state.active.dueAt || input.motionBusy) return output;
    const index = state.active.index + 1;
    if (index < state.active.steps.length) {
      next.active = { ...state.active, index, dueAt: now + state.active.steps[index][1] }; output.word = state.active.steps[index][0];
    } else {
      next.active = null; output.release = true;
      if (state.active.manual) output.completed = true;
    }
    return output;
  }
  if (!automatic) { next.inviteAt = now + 1800000; return output; }
  if (mode === 'interactive' && period === 'day' && eligible && recipe('play', words) && !state.invitation && now >= state.inviteAt) {
    next.invitation = 'pending'; next.inviteAt = now + invitationWait(random); output.reserveInvitation = true; return output;
  }
  return output;
}
