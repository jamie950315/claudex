import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = 1;
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 16;
export const SIGNATURE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

// Bundle paths whose identity changes when an app is replaced, updated or
// resealed. An in-place edit of another nested file is not observable here,
// so every entry also expires after a bounded age.
const IDENTITY_PATHS = ['', 'Contents', 'Contents/Info.plist', 'Contents/MacOS',
  'Contents/_CodeSignature', 'Contents/_CodeSignature/CodeResources'];

async function bundleIdentity(app) {
  const parts = [];
  for (const relative of IDENTITY_PATHS) {
    let stat;
    try { stat = await lstat(relative ? join(app, relative) : app, { bigint: true }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    if (stat.isSymbolicLink()) return null;
    parts.push([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'));
  }
  return parts.join('|');
}

const specKey = spec => JSON.stringify([spec.id, spec.team, Boolean(spec.allowLocalResign)]);

/** A bounded private record of successful deep app signature verifications.
 * It only lets periodic read-only inspection skip re-running an unchanged
 * verification within its maximum age. Setup and sign-in never reuse it, a
 * failed or unstable verification is never recorded, and any unreadable or
 * foreign cache is a miss rather than a result.
 */
export class AppSignatureCache {
  constructor({ root, reuse = true, persist = true, maxAgeMs = SIGNATURE_CACHE_MAX_AGE_MS, now = Date.now } = {}) {
    Object.assign(this, { root, path: root ? join(root, 'app-signatures.json') : null, reuse, persist, maxAgeMs, now });
    this.entries = {};
    this.loading = null;
    this.dirty = false;
  }

  identity(app) { return bundleIdentity(app); }

  // Both provider verifications run concurrently and share one read.
  load() {
    this.loading ??= this.read();
    return this.loading;
  }

  async read() {
    this.entries = {};
    if (!this.path) return this.entries;
    let handle;
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { return this.entries; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) return this.entries;
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data?.version === VERSION && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries))
        for (const [app, entry] of Object.entries(data.entries)) {
          if (typeof entry?.spec === 'string' && typeof entry.identity === 'string' && Number.isFinite(entry.verifiedAt)
            && ['vendor', 'local'].includes(entry.signature)) this.entries[app] = entry;
        }
    } catch { /* A malformed cache only means full verification. */ }
    finally { await handle.close(); }
    return this.entries;
  }

  async lookup(app, spec, identity) {
    if (!this.reuse || !identity) return null;
    const entry = (await this.load())[app];
    const age = this.now() - (entry?.verifiedAt ?? NaN);
    if (!entry || entry.spec !== specKey(spec) || entry.identity !== identity || !(age >= 0 && age < this.maxAgeMs)) return null;
    return entry.signature;
  }

  async record(app, spec, signature, identity) {
    if (!this.persist || !identity || !['vendor', 'local'].includes(signature)) return;
    // Only a bundle whose identity did not change during verification is recorded.
    if (await bundleIdentity(app) !== identity) return;
    const entries = await this.load();
    entries[app] = { spec: specKey(spec), identity, verifiedAt: this.now(), signature };
    this.dirty = true;
  }

  async save() {
    if (!this.persist || !this.dirty || !this.path) return;
    this.dirty = false;
    let directory;
    try { directory = await lstat(this.root); } catch { return; }
    // Never create or populate an application root that setup has not made private.
    if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) return;
    const entries = Object.fromEntries(Object.entries(this.entries)
      .sort(([, a], [, b]) => b.verifiedAt - a.verifiedAt).slice(0, MAX_ENTRIES));
    const text = `${JSON.stringify({ version: VERSION, entries })}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) return;
    // A disposable cache: an interrupted write can only produce a later miss.
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.next`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch {
      // Losing an optimization record never blocks inspection; the next run verifies fully.
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
