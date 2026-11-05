async function call(command, value, raw = false) {
  const response = await fetch(`./api/characters/${command}`, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': raw ? 'application/zip' : 'application/json' }, body: raw ? value : JSON.stringify(value),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
/** The browser preview and Desktop share the same API 2 pack store and sandbox runtime. */
export const browserCharacters = {
  list: () => call('list'), load: id => call('load', { id }),
  select: (id, scheme = '') => call('select', { id, scheme }),
  remove: id => call('remove', { id }), import: bytes => call('import', bytes, true),
};
