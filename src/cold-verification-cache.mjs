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
    this.serial = Promise.resolve();
    this.health = { state: 'ready', reason: null, entries: null, bytes: null, reclaimedEntries: 0 };
  }

  diagnostics() {
    return { ...this.health, disabled: this.health.state === 'disabled', capacityReached: this.health.state === 'capacity',
      limits: { entries: MAX_ENTRIES, fileBytes: MAX_FILE, totalBytes: MAX_TOTAL } };
  }
  refuse(reason, state = 'disabled') { Object.assign(this.health, { state, reason }); return false; }
  transaction(operation) {
    const work = this.serial.catch(() => {}).then(operation); this.serial = work; return work;
  }

  async checkDirectory(create = false) {
    if (!privateDirectory(await lstat(this.root, { bigint: true })) || await realpath(this.root) !== this.root) throw new Error('Unsafe cache root.');
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(this.directory, { bigint: true });
    if (!privateDirectory(stat) || await realpath(this.directory) !== this.directory) throw new Error('Unsafe cache directory.');
    return `${stat.dev}:${stat.ino}`;
  }

  mac(payload) { return createHmac('sha256', this.key).update('claudex-cold-verification\0').update(json(payload)).digest('hex'); }

  async readEnvelope(path) {
    const directory = await this.checkDirectory();
    const before = await lstat(path, { bigint: true });
    if (!privateFile(before) || before.size <= 0n || before.size > BigInt(MAX_FILE)) throw new Error('Unsafe cache file.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(verificationFileIdentity(before), verificationFileIdentity(await file.stat({ bigint: true })))) return null;
      const text = await file.readFile('utf8');
      if (!same(verificationFileIdentity(before), verificationFileIdentity(await file.stat({ bigint: true })))
          || !same(verificationFileIdentity(before), verificationFileIdentity(await lstat(path, { bigint: true })))
          || await this.checkDirectory() !== directory) return null;
      const envelope = JSON.parse(text);
      if (Object.keys(envelope).sort().join(',') !== 'mac,payload' || !HASH.test(envelope.mac)
          || !timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(this.mac(envelope.payload), 'hex'))) return null;
      return { payload: envelope.payload, identity: verificationFileIdentity(before) };
    } finally { await file.close(); }
  }

  async generation() {
    try {
      const value = await this.readEnvelope(join(this.directory, '.revocation.json'));
      if (!value || value.payload?.version !== 1 || !ID.test(value.payload.generation)) throw new Error('Invalid cache revocation fence.');
      return value.payload.generation;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async read(id) {
    if (!ID.test(id) || this.disabled.has(id)) return null;
    const generation = await this.generation();
    const entry = await this.readEnvelope(join(this.directory, `${id}.json`)), payload = entry?.payload;
    return payload?.version === 1 && payload.epoch === this.epoch && payload.id === id
      && (payload.cacheGeneration ?? null) === generation && await this.generation() === generation ? payload : null;
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
          || !await this.validateFiles(payload.files, payload.assetDirectory) || this.disabled.has(id)
          || (payload.cacheGeneration ?? null) !== await this.generation()) return null;
      // Invalidation may have replaced this proof during the awaited asset checks.
      // Re-read the authenticated entry, not just the global reclamation fence.
      return same(payload, await this.read(id)) && !this.disabled.has(id) ? payload : null;
    } catch (error) { if (error.code !== 'ENOENT') this.refuse('storage-unavailable'); return null; }
  }

  async inventory() {
    let count = 0, bytes = 0, scanned = 0;
    const files = [];
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      if (++scanned > MAX_ENTRIES + 1) { this.refuse('entry-capacity', 'capacity'); return null; }
      if ((entry.name !== '.revocation.json' && !ID.test(entry.name.slice(0, -5))) || !entry.name.endsWith('.json')) {
        this.refuse('unsafe-storage'); return null;
      }
      const path = join(this.directory, entry.name), stat = await lstat(path, { bigint: true });
      if (!privateFile(stat)) { this.refuse('unsafe-storage'); return null; }
      bytes += Number(stat.size);
      if (entry.name !== '.revocation.json') { count++; files.push({ path, name: entry.name, bytes: Number(stat.size), identity: verificationFileIdentity(stat) }); }
    }
    Object.assign(this.health, { entries: count, bytes });
    return { count, bytes, files };
  }

  async publish(name, payload, directory) {
    const text = json({ payload, mac: this.mac(payload) });
    const temporary = join(this.directory, `${randomUUID()}.next`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      if (await this.checkDirectory() !== directory) return false;
      await rename(temporary, join(this.directory, name));
      const handle = await open(this.directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      return true;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async write(id, payload) {
    if (!ID.test(id)) return this.refuse('invalid-id');
    const directory = await this.checkDirectory(true);
    let generation = await this.generation();
    let value = { ...payload, ...(generation === null ? {} : { cacheGeneration: generation }) };
    let size = Buffer.byteLength(json({ payload: value, mac: this.mac(value) }));
    if (size > MAX_FILE) return this.refuse('file-capacity', 'capacity');
    let inventory = await this.inventory();
    if (!inventory) return false;
    const fits = () => {
      const old = inventory.files.find(file => file.name === `${id}.json`);
      return inventory.count + (old ? 0 : 1) <= MAX_ENTRIES && inventory.bytes - (old?.bytes ?? 0) + size <= MAX_TOTAL;
    };
    if (!fits()) {
      const invalidated = [];
      let revokeGeneration = false;
      for (const file of inventory.files) {
        const entry = await this.readEnvelope(file.path);
        if (entry?.payload?.version === 1 && entry.payload.epoch === this.epoch
          && entry.payload.id === file.name.slice(0, -5) && same(entry.identity, file.identity)) {
          const current = (entry.payload.cacheGeneration ?? null) === generation;
          if (entry.payload.invalidated === true || !current) {
            invalidated.push(file);
            if (current) revokeGeneration = true;
          }
        }
      }
      if (!invalidated.length) return this.refuse(inventory.count >= MAX_ENTRIES ? 'entry-capacity' : 'byte-capacity', 'capacity');
      // Publish the new authenticated generation BEFORE removing tombstones.
      // Restoring any old proof/context then remains a miss, including after restart.
      if (revokeGeneration) {
        generation = randomUUID();
        if (!await this.publish('.revocation.json', { version: 1, generation }, directory)) return this.refuse('directory-changed');
      }
      for (const file of invalidated) {
        if (await this.checkDirectory() !== directory
          || !same(file.identity, verificationFileIdentity(await lstat(file.path, { bigint: true })))) return this.refuse('storage-changed');
        await unlink(file.path); this.health.reclaimedEntries++;
      }
      const handle = await open(this.directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      value = { ...payload, cacheGeneration: generation };
      size = Buffer.byteLength(json({ payload: value, mac: this.mac(value) }));
      if (size > MAX_FILE) return this.refuse('file-capacity', 'capacity');
      inventory = await this.inventory();
      if (!inventory) return false;
      if (!fits()) return this.refuse(inventory.count >= MAX_ENTRIES ? 'entry-capacity' : 'byte-capacity', 'capacity');
    }
    if (await this.generation() !== generation) return this.refuse('revocation-changed');
    if (!await this.publish(`${id}.json`, value, directory)) return this.refuse('directory-changed');
    const old = inventory.files.find(file => file.name === `${id}.json`);
    Object.assign(this.health, { state: 'ready', reason: null, entries: inventory.count + (old ? 0 : 1), bytes: inventory.bytes - (old?.bytes ?? 0) + size });
    return true;
  }

  async store(id, { signature, context, files, verifiedAt = this.now() }) {
    return this.transaction(() => this.storeVerified(id, { signature, context, files, verifiedAt }));
  }
  async storeVerified(id, { signature, context, files, verifiedAt }) {
    try {
      const assetDirectory = await this.assetDirectoryIdentity();
      if (!assetDirectory || !Number.isSafeInteger(verifiedAt) || verifiedAt < 0 || verifiedAt > this.now()
          || !await this.validateFiles(files, assetDirectory)) return this.refuse('verification-unavailable');
      const payload = { version: 1, epoch: this.epoch, id, signature: digest(signature), contextHash: digest(context), verifiedAt, assetDirectory, files };
      const previous = await this.read(id).catch(() => null);
      if (previous && !previous.invalidated && previous.signature === payload.signature && previous.contextHash === payload.contextHash
          && previous.verifiedAt <= this.now() && this.now() - previous.verifiedAt <= this.maxAgeMs
          && same(previous.files, files) && same(previous.assetDirectory, assetDirectory)) return true;
      if (!await this.write(id, payload)) return false;
      this.disabled.delete(id); this.durableInvalidations.delete(id); return true;
    } catch { return this.refuse('storage-unavailable'); }
  }

  async invalidate(id) {
    return this.transaction(() => this.invalidateVerified(id));
  }
  async invalidateVerified(id) {
    if (!ID.test(id)) return false;
    this.disabled.add(id);
    if (this.durableInvalidations.has(id)) return true;
    try {
      const written = await this.write(id, { version: 1, epoch: this.epoch, id, invalidated: true });
      if (written) this.durableInvalidations.add(id);
      return written;
    }
    catch { return this.refuse('revocation-unavailable'); }
  }
}
