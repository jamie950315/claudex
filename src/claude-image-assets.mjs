import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { hash, publishExclusive, withLock } from './storage.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const EXTENSIONS = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'] };
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalizedImage = block => ({ type: 'image', source: { type: block.source?.type,
  media_type: block.source?.media_type, data: block.source?.data } });

function checkFile(info, label) {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error(`${label} must be a private owned regular file.`);
}

async function checkDirectory(path, label, privateMode = true) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) throw new Error(`${label} must be a private owned directory.`);
}

async function readPrivateFile(path, label) {
  const before = await lstat(path);
  checkFile(before, label);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    checkFile(opened, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed while being read.`);
    const bytes = await file.readFile();
    const after = await lstat(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error(`${label} changed while being read.`);
    return bytes;
  } finally { await file.close(); }
}

async function assetDirectory(root, create) {
  if (!isAbsolute(root)) throw new Error('Image asset root must be absolute.');
  await checkDirectory(root, 'Image asset root');
  const directory = join(root, 'image-assets');
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await checkDirectory(directory, 'Image asset directory');
  return directory;
}

async function storeAsset(root, digest, bytes) {
  const directory = await assetDirectory(root, true);
  const path = join(directory, digest);
  await withLock(join(directory, '.write.lock'), async () => {
    let present = true;
    try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
    if (!present) await publishExclusive(path, bytes);
    const stored = await readPrivateFile(path, 'Image asset');
    if (bytesHash(stored) !== digest || !stored.equals(bytes)) throw new Error('Image asset content changed or collided.');
  }, { recoverDead: true });
}

async function originalImage({ claudeTempRoot, cwd, sessionId, pasteId, mediaType }) {
  if (!isAbsolute(claudeTempRoot) || !isAbsolute(cwd) || !UUID.test(sessionId)
      || !Number.isSafeInteger(pasteId) || pasteId < 0) throw new Error('Invalid native image cache identity.');
  const encoded = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length > 200) throw new Error('Native image cache project key is too long.');
  const project = join(claudeTempRoot, encoded);
  const session = join(project, sessionId);
  const images = join(session, 'images');
  for (const directory of [claudeTempRoot, project]) await checkDirectory(directory, 'Native image cache directory');
  // The pinned CLI creates these inner directories as 0755. Their private
  // ancestors prevent traversal; still reject other-user writes and symlinks.
  for (const directory of [session, images]) await checkDirectory(directory, 'Native image cache directory', false);
  const extensions = EXTENSIONS[mediaType];
  if (!extensions) throw new Error('Unsupported native image asset type.');
  let found = null;
  for (const extension of extensions) {
    const path = join(images, `${pasteId}.${extension}`);
    try { await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (found) throw new Error('Ambiguous native image cache asset.');
    found = path;
  }
  if (!found) throw new Error('Original native image cache asset is missing.');
  return readPrivateFile(found, 'Native image cache asset');
}

function imageBytes(block) {
  const data = block?.source?.data;
  if (block?.type !== 'image' || block.source?.type !== 'base64' || typeof data !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new Error('Expected image must contain canonical inline base64.');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data) throw new Error('Expected image base64 is not canonical.');
  return bytes;
}

/** Bind native resized previews to the exact original bytes of a pending owner append. */
export async function captureImageAssets({ root, claudeTempRoot, cwd, sessionId, row, expectedContent, expectedHash, normalizeContent }) {
  if (typeof normalizeContent !== 'function' || !DIGEST.test(expectedHash)
      || hash(normalizeContent(expectedContent)) !== expectedHash) throw new Error('Invalid expected owner append content.');
  const expected = normalizeContent(expectedContent);
  const rendered = normalizeContent(row?.message?.content);
  if (!Array.isArray(expected) || !Array.isArray(rendered) || expected.length !== rendered.length)
    throw new Error('Native image append content length differs from the durable intent.');
  if (hash(rendered) === expectedHash) return { row, bindings: {} };
  if (row.queueTranscriptOnly !== true || row.promptSource !== 'sdk' || row.version !== '2.1.281')
    throw new Error('Native image append provenance is unsupported.');
  const imageIndices = expected.flatMap((block, index) => block?.type === 'image' ? [index] : []);
  if (!imageIndices.length || !Array.isArray(row.imagePasteIds) || row.imagePasteIds.length !== imageIndices.length
      || new Set(row.imagePasteIds).size !== row.imagePasteIds.length
      || row.imagePasteIds.some(id => !Number.isSafeInteger(id) || id < 0))
    throw new Error('Native image paste identities do not match the durable intent.');
  const restored = [...rendered];
  const bindings = {};
  const originals = [];
  for (let index = 0, image = 0; index < expected.length; index++) {
    if (expected[index]?.type !== 'image') {
      if (!same(expected[index], rendered[index])) throw new Error('Native append changed nonimage content.');
      continue;
    }
    const original = expected[index];
    const preview = rendered[index];
    if (preview?.type !== 'image' || preview.source?.type !== 'base64'
        || preview.source.media_type !== original.source?.media_type) throw new Error('Native image preview type differs from the durable intent.');
    imageBytes(preview);
    if (same(preview, original)) { image++; continue; }
    const bytes = await originalImage({ claudeTempRoot, cwd, sessionId, pasteId: row.imagePasteIds[image++], mediaType: original.source.media_type });
    if (!bytes.equals(imageBytes(original))) throw new Error('Native image cache asset differs from the durable intent.');
    const assetHash = bytesHash(bytes);
    bindings[index] = { assetHash, mediaType: original.source.media_type, renderedHash: hash(normalizedImage(preview)) };
    originals.push({ assetHash, bytes });
    restored[index] = original;
  }
  if (hash(normalizeContent(restored)) !== expectedHash) throw new Error('Restored native image append differs from the durable intent.');
  for (const { assetHash, bytes } of originals) await storeAsset(root, assetHash, bytes);
  return { row: { ...row, message: { ...row.message, content: restored } }, bindings };
}

/** Rehydrate only previews bound to a saved native message UUID and asset hash. */
export async function restoreImageAssets({ root, rows, bindings }) {
  if (!Array.isArray(rows) || !bindings || typeof bindings !== 'object') throw new Error('Invalid image asset restoration input.');
  if (!Object.keys(bindings).length) return rows;
  const restored = [];
  for (const row of rows) {
    const bound = bindings[row?.uuid];
    if (!bound) { restored.push(row); continue; }
    if (!UUID.test(row.uuid) || !Array.isArray(row.message?.content)) throw new Error('Bound native image row is invalid.');
    const content = [...row.message.content];
    for (const [key, binding] of Object.entries(bound)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= content.length
          || !DIGEST.test(binding?.assetHash) || !DIGEST.test(binding?.renderedHash)
          || !EXTENSIONS[binding?.mediaType]) throw new Error('Saved image binding is invalid.');
      const preview = content[index];
      if (preview?.type !== 'image' || preview.source?.media_type !== binding.mediaType
          || hash(normalizedImage(preview)) !== binding.renderedHash) throw new Error('Bound native image preview changed.');
      const directory = await assetDirectory(root, false);
      const bytes = await readPrivateFile(join(directory, binding.assetHash), 'Image asset');
      if (bytesHash(bytes) !== binding.assetHash) throw new Error('Saved image asset hash differs.');
      content[index] = { type: 'image', source: { type: 'base64', media_type: binding.mediaType, data: bytes.toString('base64') } };
    }
    restored.push({ ...row, message: { ...row.message, content } });
  }
  return restored;
}
