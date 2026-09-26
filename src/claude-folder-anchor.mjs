const anchorObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const anchorUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const anchorText = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\x00-\x1f\x7f]/.test(value);

function anchorPath(value) {
  if (!anchorText(value) || !value.startsWith('/')) return null;
  const path = value.replace(/\/+$/, '') || '/';
  if (path !== '/' && path.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  return path;
}

// Native shared-common-mcp-msg-2-DPkQMy7G.js exports dl (E_) and sm
// (Tc). Preserve their basename and owner/name semantics, not a guessed label.
function anchorFolderName(value) {
  const path = value.replace(/[\\/]$/, '');
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator === -1 ? path : path.slice(separator + 1);
}

function anchorGitInfo(value) {
  if (value === null) return null;
  if (!anchorObject(value)) throw new Error('Native Git metadata is unavailable or malformed.');
  if (!value.repo) return null;
  if (typeof value.repo !== 'string') throw new Error('Native Git repository identity is malformed.');
  const parts = value.repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!parts.every(anchorText) || value.branch != null && typeof value.branch !== 'string')
    throw new Error('Native Git repository metadata is malformed.');
  return { owner: parts[0], name: parts[1], branch: value.branch, defaultBranch: value.defaultBranch };
}

/** Reproduce only the native Local row's folder-relevant fields from a real,
 * freshly fetched LocalSessions.getSession() DTO. This descriptor is an anchor
 * for a verified existing row, never a new visible row or a native session.
 *
 * The caller authenticates/revalidates the handoff manifest and its native-ID
 * mapping; this pure helper cannot establish that provenance or expiry.
 * Fetch getGitInfo(session.harnessCwd || session.cwd), and also originCwd when
 * different. A rejected/missing read is not a null result. An explicit native
 * null means no repository, matching the native renderer's folder fallback.
 *
 * The transform is shared-13-CMYbgFMR.js's two Local normalizer branches at
 * offsets 127472/135407, source SHA-256
 * 9a42c1b9f31d93ab7ed2e7e79ec6b7d3c878e7eed403ae67bcf467c56aa27414.
 */
export function normalizeClaudeLocalFolderAnchor({ session, anchor, gitInfo, originGitInfo } = {}) {
  if (!anchorObject(session) || !anchorObject(anchor) || !anchorText(anchor.localSessionId)
      || !anchor.localSessionId.startsWith('local_') || !anchorUuid.test(anchor.localSessionId.slice(6))
      || !anchorUuid.test(anchor.nativeId) || session.sessionId !== anchor.localSessionId
      || session.cliSessionId != null && session.cliSessionId !== anchor.nativeId
      || session.isScratchWorkspace || session.remoteTarget != null || session.sshConfig != null || session.wslConfig != null)
    return null;
  if (session.originCwd !== undefined && session.originCwd !== '' && !anchorPath(session.originCwd)
      || session.harnessCwd !== undefined && session.harnessCwd !== '' && !anchorPath(session.harnessCwd)
      || session.branch !== undefined && typeof session.branch !== 'string') return null;
  const sourceCwd = anchorPath(session.cwd), expectedCwd = anchorPath(anchor.cwd);
  const cwd = session.originCwd || session.cwd, diffCwd = session.harnessCwd || session.cwd;
  const folder = anchorPath(cwd), primaryPath = anchorPath(diffCwd);
  if (!sourceCwd || !expectedCwd || !folder || !primaryPath
      || !new Set([sourceCwd, folder, primaryPath]).has(expectedCwd) || gitInfo === undefined) return null;
  let primary, origin;
  try {
    primary = anchorGitInfo(gitInfo);
    if (!primary?.owner && session.originCwd) {
      const samePath = anchorPath(session.originCwd) === primaryPath;
      if (!samePath && originGitInfo === undefined) return null;
      origin = anchorGitInfo(samePath ? gitInfo : originGitInfo);
    }
  } catch { return null; }
  const nativeName = anchorFolderName(cwd);
  const liveBranch = primary?.branch && primary.branch !== 'HEAD' && !primary.branch.startsWith('detached:') ? primary.branch : undefined;
  const branch = session.harnessCwd ? liveBranch || session.branch || '' : session.branch || liveBranch || '';
  const repoInfo = primary?.owner ? { owner: primary.owner, name: primary.name, branch }
    : origin?.owner && session.branch ? { owner: origin.owner, name: origin.name, branch: session.branch }
    : nativeName ? { owner: '', name: nativeName, branch: '' } : undefined;
  if (!repoInfo || !anchorText(repoInfo.name)) return null;
  return { id: session.sessionId, type: 'local', cwd, diffCwd, repoInfo,
    isArchived: session.isArchived ?? false, isScratchWorkspace: false };
}
