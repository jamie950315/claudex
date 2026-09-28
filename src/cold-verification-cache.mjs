import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verificationFileIdentity } from './verification-observations.mjs';
export { captureVerificationFiles } from './verification-observations.mjs';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const json = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const same = (a, b) => json(a) === json(b);
const privateFile = stat => stat.isFile() && stat.uid === BigInt(process.getuid())
  && (stat.mode & 0o7777n) === 0o600n && stat.nlink === 1n;
const privateDirectory = stat => stat.isDirectory() && stat.uid === BigInt(process.getuid())
  && (stat.mode & 0o7777n) === 0o700n;

/** Authenticated performance hints only. Callers must separately prove inactive,
 * unchanged ledger/native state before reuse; this never authorizes a write. */
export class ColdVerificationCache {
  constructor({ root, key, epoch = 'cold-verification-v1', now = Date.now, maxAgeMs = Infinity }) {
    if (!isAbsolute(root) || resolve(root) !== root || typeof epoch !== 'string' || !epoch
        || !(typeof key === 'string' || Buffer.isBuffer(key) || key instanceof Uint8Array)
        || Buffer.byteLength(key) < 32 || !(maxAgeMs > 0)) throw new Error('Invalid cold verification cache configuration.');
    this.root = root; this.directory = join(root, 'cold-verification');
    this.assets = join(root, 'history-assets'); this.key = Buffer.from(key);
    this.epoch = epoch; this.now = now; this.maxAgeMs = maxAgeMs;
    this.disabled = new Set();
    this.durableInvalidations = new Set();
  }

  async checkDirectory(create = false) {
    if (!privateDirectory(await lstat(this.root, { bigint: true })) || await realpath(this.root) !== this.root) throw new Error('Unsafe cache root.');
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(this.directory, { bigint: true });
    if (!privateDirectory(stat) || await realpath(this.directory) !== this.directory) throw new Error('Unsafe cache directory.');
    return `${stat.dev}:${stat.ino}`;
  }

  mac(payload) { return createHmac('sha256', this.key).update('claudex-cold-verification\0').update(json(payload)).digest('hex'); }

  async read(id) {
    if (!ID.test(id) || this.disabled.has(id)) return null;
    const directory = await this.checkDirectory();
    const path = join(this.directory, `${id}.json`);
    const before = await lstat(path, { bigint: true });
    if (!privateFile(before) || before.size <= 0n || before.size > BigInt(MAX_FILE)) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(verificationFileIdentity(before), verificationFileIdentity(await file.stat({ bigint: true })))) return null;
      const text = await file.readFile('utf8');
      if (!same(verificationFileIdentity(before), verificationFileIdentity(await file.stat({ bigint: true })))
          || !same(verificationFileIdentity(before), verificationFileIdentity(await lstat(path, { bigint: true })))
          || await this.checkDirectory() !== directory) return null;
      const envelope = JSON.parse(text);
      if (Object.keys(envelope).sort().join(',') !== 'mac,payload' || !HASH.test(envelope.mac)
          || !timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(this.mac(envelope.payload), 'hex'))) return null;
      const payload = envelope.payload;
      return payload?.version === 1 && payload.epoch === this.epoch && payload.id === id ? payload : null;
    } finally { await file.close(); }
  }

  async assetDirectoryIdentity() {
    const stat = await lstat(this.assets, { bigint: true });
    if (!privateDirectory(stat) || await realpath(this.assets) !== this.assets) return null;
    return { path: this.assets, dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(), mode: stat.mode.toString() };
  }

  async validateFiles(files, expectedDirectory) {
    if (!Array.isArray(files) || files.length > 65536) return false;
    const directory = await this.assetDirectoryIdentity();
    if (!directory || expectedDirectory && !same(directory, expectedDirectory)) return false;
    const paths = new Set();
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || !HASH.test(file.path.slice(this.assets.length + 1))
          || file.path !== join(this.assets, file.path.slice(this.assets.length + 1)) || paths.has(file.path)) return false;
      paths.add(file.path);
    }
    for (let offset = 0; offset < files.length; offset += 8) {
      const batch = await Promise.all(files.slice(offset, offset + 8).map(async file => {
        try {
          const stat = await lstat(file.path, { bigint: true });
          return privateFile(stat) && same(file.identity, verificationFileIdentity(stat)) && await realpath(file.path) === file.path;
        } catch { return false; }
      }));
      if (batch.some(valid => !valid)) return false;
    }
    return same(await this.assetDirectoryIdentity(), directory);
  }

  async load(id, signature, context) {
    try {
      const payload = await this.read(id);
      if (!payload || payload.invalidated || payload.signature !== digest(signature) || payload.contextHash !== digest(context)
          || !Number.isSafeInteger(payload.verifiedAt) || payload.verifiedAt < 0 || payload.verifiedAt > this.now()
          || this.now() - payload.verifiedAt > this.maxAgeMs || !payload.assetDirectory
          || !await this.validateFiles(payload.files, payload.assetDirectory)) return null;
      return payload;
    } catch { return null; }
  }

  async write(id, payload) {
    if (!ID.test(id)) return false;
    const directory = await this.checkDirectory(true);
    const text = json({ payload, mac: this.mac(payload) });
    if (Buffer.byteLength(text) > MAX_FILE) return false;
    let count = 0, bytes = 0, previousBytes = 0, exists = false;
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      if (++count > MAX_ENTRIES) return false;
      const stat = await lstat(join(this.directory, entry.name), { bigint: true });
      if (!privateFile(stat)) return false;
      bytes += Number(stat.size);
      if (entry.name === `${id}.json`) { previousBytes = Number(stat.size); exists = true; }
      if (bytes > MAX_TOTAL) return false;
    }
    if (!exists && count >= MAX_ENTRIES || bytes - previousBytes + Buffer.byteLength(text) > MAX_TOTAL) return false;
    const temporary = join(this.directory, `${id}.${randomUUID()}.next`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    try {
      if (await this.checkDirectory() !== directory) return false;
      await rename(temporary, join(this.directory, `${id}.json`));
      const handle = await open(this.directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      return true;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async store(id, { signature, context, files, verifiedAt = this.now() }) {
    try {
      const assetDirectory = await this.assetDirectoryIdentity();
      if (!assetDirectory || !Number.isSafeInteger(verifiedAt) || verifiedAt < 0 || verifiedAt > this.now()
          || !await this.validateFiles(files, assetDirectory)) return false;
      const payload = { version: 1, epoch: this.epoch, id, signature: digest(signature), contextHash: digest(context), verifiedAt, assetDirectory, files };
      const previous = await this.read(id).catch(() => null);
      if (previous && !previous.invalidated && previous.signature === payload.signature && previous.contextHash === payload.contextHash
          && previous.verifiedAt <= this.now() && this.now() - previous.verifiedAt <= this.maxAgeMs
          && same(previous.files, files) && same(previous.assetDirectory, assetDirectory)) return true;
      if (!await this.write(id, payload)) return false;
      this.disabled.delete(id); this.durableInvalidations.delete(id); return true;
    } catch { return false; }
  }

  async invalidate(id) {
    if (!ID.test(id)) return false;
    this.disabled.add(id);
    if (this.durableInvalidations.has(id)) return true;
    try {
      const written = await this.write(id, { version: 1, epoch: this.epoch, id, invalidated: true });
      if (written) this.durableInvalidations.add(id);
      return written;
    }
    catch { return false; }
  }
}
