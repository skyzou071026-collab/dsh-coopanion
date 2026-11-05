import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sdk = process.env.COOPANION_ASAR_SDK;
assert(sdk?.replaceAll('\\', '/').includes('/Contents/Resources/app.asar/dsh'), 'Use only the inspected official Desktop SDK');
const anchor = pathToFileURL(join(sdk, 'package.json')).href;
registerHooks({ resolve(specifier, context, next) {
  const isFile = specifier.startsWith('file:');
  const path = isFile ? fileURLToPath(specifier) : specifier;
  if (isFile && path.startsWith(sdk + sep)) return next(specifier, context);
  const match = /(?:^|\/)@deepseek-ai\/([\w-]+)(\/.*)?$/.exec(path.replaceAll('\\', '/')), name = match?.[1];
  if (name && !/^dsh-client|^dsh-web|^dsh$/.test(name)) {
    let result;
    if (isFile) {
      const metadata = next('@deepseek-ai/' + name + '/package.json', { ...context, parentURL: anchor });
      result = next(pathToFileURL(join(dirname(fileURLToPath(metadata.url)), (match[2] ?? '').slice(1))).href, context);
    } else result = next(specifier, { ...context, parentURL: anchor });
    const resolved = fileURLToPath(result.url);
    assert(resolved.startsWith(sdk + sep), 'Desktop Host modules must resolve into the signed ASAR');
    if (process.env.COOPANION_ASAR_RESOLUTION_LOG) appendFileSync(process.env.COOPANION_ASAR_RESOLUTION_LOG, JSON.stringify({ name, sha256: createHash('sha256').update(readFileSync(resolved)).digest('hex') }) + '\n');
    return result;
  }
  return next(specifier, context);
} });
