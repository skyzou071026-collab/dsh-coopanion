import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

it('requests current native geometry after the renderer listener is attached', () => {
  let api, listener;
  const sent = [];
  const ipcRenderer = {
    on(channel, fn) { expect(channel).toBe('pet:update'); listener = fn; },
    send(channel) { sent.push(channel); listener(null, { type: 'display-changed', revision: sent.length }); },
    removeListener(channel, fn) { expect(channel).toBe('pet:update'); expect(fn).toBe(listener); listener = undefined; },
  };
  runInNewContext(readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), {
    process: { argv: [] },
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { expect(name).toBe('dshPetBridge'); api = value; } } }),
  });
  const received = [];
  const unsubscribe = api.subscribe(value => received.push(value));
  expect(received).toEqual([{ type: 'display-changed', revision: 1 }]);
  api.requestGeometry(); expect(received.at(-1).revision).toBe(2);
  expect(sent).toEqual(['pet:geometry-request', 'pet:geometry-request']);
  unsubscribe(); expect(listener).toBeUndefined();
});
