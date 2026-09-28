import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat } from 'node:fs/promises';

const observations = new AsyncLocalStorage();
const FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'uid', 'mode', 'nlink'];
export const verificationFileIdentity = stat => Object.fromEntries(FIELDS.map(key => [key, stat[key].toString()]));

/** Observe only successful authenticated archive reads; this is not authorization. */
export async function captureVerificationFiles(operation) {
  const state = { files: new Map(), invalid: false };
  const result = await observations.run(state, operation);
  return { result, files: state.invalid ? null : [...state.files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function beginVerificationFile(file) {
  return observations.getStore() ? verificationFileIdentity(await file.stat({ bigint: true })) : null;
}

export async function recordVerificationFile(path, file, before) {
  const state = observations.getStore();
  if (!state || !before || state.invalid) return;
  const after = verificationFileIdentity(await file.stat({ bigint: true }));
  const named = verificationFileIdentity(await lstat(path, { bigint: true }));
  const identity = JSON.stringify(before);
  if (identity !== JSON.stringify(after) || identity !== JSON.stringify(named)
      || state.files.has(path) && identity !== JSON.stringify(state.files.get(path).identity)
      || state.files.size >= 65536 && !state.files.has(path)) {
    state.invalid = true; state.files.clear(); return;
  }
  state.files.set(path, { path, identity: before });
}
