import assert from 'node:assert/strict';
export async function controlCompanionClock(page) {
  await page.addInitScript(() => { window.companionNow = 0; window.companionHour = 12; window.companionRandom = .1; window.companionEvents = [];
    const keyboard = () => { window.receive?.({ type: 'keyboard-activity', value: 'idle' }); requestAnimationFrame(keyboard); }; requestAnimationFrame(keyboard); });
  await page.route('**/companionship.js', async route => {
    const response = await route.fetch(), source = await response.text();
    assert.ok(source.includes('export function stepCompanionship('));
    await route.fulfill({ response, body: source.replace('export function stepCompanionship(', 'function actualStepCompanionship(') + `
export function stepCompanionship(state, input, random) {
  input = {...input, now: window.companionNow ?? input.now, hour: window.companionHour ?? input.hour};
  const result = actualStepCompanionship(state, input, () => window.companionRandom);
  window.companionState = result.state; window.companionInput = input;
  if (result.word || result.reserveInvitation || result.showInvitation || result.completed || result.hideInvitation) window.companionEvents.push({now:input.now,...result});
  return result;
}
` });
  });
}
export async function advanceCompanion(page, target) {
  await page.evaluate(async target => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    while (window.companionNow < target) { window.companionNow = Math.min(target, window.companionNow + 5000); await frame(); }
    await frame();
  }, target);
}
