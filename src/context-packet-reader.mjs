import { decodeContextPacket } from './context-packet.mjs';
import { inspectArchivedContextPacket, decodeArchivedContextPacket, loadContextArchive } from './context-archive.mjs';

/** Mixed-version reader. A recognizable damaged packet must fail, never become
 * newly authored text. Archive resolution is provided by the trusted caller.
 */
export function decodeTransportPacket(options) {
  // The archived decoder authenticates (and returns null for) exactly what the
  // archived inspector recognizes; one pass avoids a second full HMAC and image
  // validation of the same immutable content.
  return decodeArchivedContextPacket(options) ?? decodeContextPacket(options);
}

/** Authenticate every reference before I/O and bind visible lookup paths to
 * the configured state root. Never use a native message as a filesystem root.
 */
export async function prepareArchiveResolver({ root, contents, conversationId, targetSessionId, key }) {
  const archives = new Map();
  for (const content of contents) {
    const metadata = inspectArchivedContextPacket({ content, conversationId, targetSessionId, key });
    if (!metadata) continue;
    if (metadata.archiveRoot !== root) throw new Error('Archived context belongs to a different configured root; no history was loaded.');
    if (!archives.has(metadata.archive.hash)) archives.set(metadata.archive.hash,
      await loadContextArchive({ root, archive: metadata.archive }));
  }
  return reference => {
    const loaded = archives.get(reference.hash);
    if (!loaded) throw new Error('Authenticated context archive was not loaded; no partial history was returned.');
    return loaded;
  };
}
