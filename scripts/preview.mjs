import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { CompanionStore } = require('../dist/companion-store.cjs');
const { CharacterStore } = require('../dist/character-store.cjs');
const { createPetServer } = require('../dist/figure-server.cjs');

export function previewServer({ dataDir = fileURLToPath(new URL('../.cache/preview-figures-v2/', import.meta.url)) } = {}) {
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  return createPetServer({ webRoot, companions: new CompanionStore(dataDir + '/companionship-v1'), store: new CharacterStore(dataDir, fileURLToPath(new URL('../web/upstream/whale/', import.meta.url))) });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  previewServer().listen(port, '127.0.0.1', () => console.log(`Browser demo listening on http://127.0.0.1:${port}; Harness events are simulated.`));
}
