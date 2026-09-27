import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const glyphs = {
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  G: ['01110','10001','10000','10111','10001','10001','01110'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};

/** Deterministic valid RGB PNG. Incompressible noise makes the attachment
 * genuinely large; the black/white banner remains readable after resizing.
 */
export function largePng({ width = 2400, height = 800, label = 'PNG 5M' } = {}) {
  const stride = width * 3 + 1, pixels = Buffer.alloc(stride * height);
  let state = 0x31415926;
  for (let y = 0; y < height; y++) for (let x = 1; x < stride; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pixels[y * stride + x] = state & 255;
  }
  const paint = (x, y, value) => pixels.fill(value, y * stride + 1 + x * 3, y * stride + 4 + x * 3);
  const scale = 14, left = 32, top = 26;
  for (let y = 0; y < 150; y++) for (let x = 0; x < Math.min(width, 900); x++) paint(x, y, 0);
  for (const [index, letter] of [...label].entries()) for (const [y, row] of glyphs[letter].entries())
    for (const [x, bit] of [...row].entries()) if (bit === '1')
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++)
        paint(left + index * 6 * scale + x * scale + dx, top + y * scale + dy, 255);
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function createLargeAttachmentAssets(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pngPath = join(directory, 'large-png-5m.png');
  const jpegSourcePath = join(directory, 'large-jpeg-source.png');
  const jpegPath = join(directory, 'large-jpeg-5m.jpg');
  await writeFile(pngPath, largePng(), { mode: 0o600 });
  await writeFile(jpegSourcePath, largePng({ width: 2600, height: 1800, label: 'JPEG 5M' }), { mode: 0o600 });
  await execute('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', jpegSourcePath, '--out', jpegPath]);
  await chmod(jpegPath, 0o600);
  const assets = [];
  for (const [path, mediaType] of [[pngPath, 'image/png'], [jpegPath, 'image/jpeg']]) {
    const bytes = await readFile(path);
    assets.push({ path, mediaType, bytes: bytes.length, sha256: digest(bytes) });
  }
  return assets;
}
