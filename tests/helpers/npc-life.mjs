// Deterministic perception/clock only; the body, walk, stop and arrival remain real API 2.
export async function controlNpc(page) {
  await page.addInitScript(() => { window.npcNow = 0; window.npcEvents = []; window.npcTrace = []; window.npcKeyboard = 'idle'; const OriginalDate = Date; window.Date = class extends OriginalDate { getHours() { return 12; } }; });
  await page.route('**/npc-life.js', async route => {
    const response = await route.fetch(), source = await response.text();
    await route.fulfill({ response, body: source.replace('export function stepNpc(', 'function actualStepNpc(') + `
export function stepNpc(state, input) {
  input = {...input, now: window.npcNow, keyboard: window.npcKeyboard, pointer: Object.hasOwn(window, 'npcPointer') ? window.npcPointer : input.pointer};
  const result = actualStepNpc(state, input);
  if (state.phase !== result.state.phase || state.reason !== result.state.reason || result.walk || result.stop) { window.npcTrace.push({now: input.now, phase: result.state.phase, reason: result.state.reason, x: input.layout?.x, mode: input.layout?.mode, event: input.event, stop: result.stop, walk: result.walk, space: input.space}); window.npcTrace = window.npcTrace.slice(-60); }
  window.npcState = result.state; window.npcInput = input;
  if (result.walk || result.stop || result.word || result.place !== undefined) window.npcEvents.push({...result, now:input.now});
  return result;
}
` });
  });
}
export async function npcTick(page, ms = 1000) {
  await page.evaluate(async ms => { window.npcNow += ms; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, ms);
}
export async function npcUntil(page, phase) {
  for (let i = 0; i < 100 && await page.evaluate(p => window.npcState.phase !== p, phase); i++) await npcTick(page);
  if (await page.evaluate(p => window.npcState.phase !== p, phase)) throw Error('NPC did not reach ' + phase + ': ' + await page.evaluate(() => JSON.stringify(window.npcState)));
}
