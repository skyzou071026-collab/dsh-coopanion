const { contextBridge, ipcRenderer } = require('electron');
async function characterCall(channel, value) {
  const result = await ipcRenderer.invoke(channel, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('dshPetBridge', {
  nativeGeometry: true,
  ...(process.argv.includes('--dsh-pet-display-test') ? { testScreenPoint: value => ipcRenderer.invoke('pet:test-screen-point', value) } : {}),
  subscribe(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('pet:update', listener);
    ipcRenderer.send('pet:geometry-request');
    return () => ipcRenderer.removeListener('pet:update', listener);
  },
  requestGeometry() { ipcRenderer.send('pet:geometry-request'); },
  // Chat carries its immutable target and client request identity unchanged.
  action(value) { ipcRenderer.send('pet:action', value); },
  hit(active) { ipcRenderer.send('pet:hit', active); },
  diagnosticsRespond: value => ipcRenderer.send('pet:diagnostics-response', value),
  companionship: value => characterCall('pet:companionship', value),
  characters: {
    list: () => characterCall('pet:characters:list'),
    load: id => characterCall('pet:characters:load', id),
    select: (id, scheme = '') => characterCall('pet:characters:select', { id, scheme }),
    remove: id => characterCall('pet:characters:remove', id),
    import: bytes => characterCall('pet:characters:import', bytes),
  },
});
