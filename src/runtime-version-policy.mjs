import { join } from 'node:path';
import { readJSON } from './storage.mjs';

/** Version policy is separate from protocol, ownership and history validation. */
export function normalizeVersionPolicy(value = 'strict') {
  if (!['strict', 'warn'].includes(value)) throw new Error('versionPolicy must be strict or warn.');
  return value;
}

export async function readVersionPolicy(root) {
  const config = await readJSON(join(root, 'config.json'), null);
  return normalizeVersionPolicy(config?.versionPolicy);
}

export function runtimeVersionPermitted(actual, known, policy = 'strict') {
  policy = normalizeVersionPolicy(policy);
  if (typeof actual !== 'string' || !actual.length || actual.length > 160 || /[\r\n\0]/.test(actual)) return false;
  return policy === 'warn' || actual === known;
}
