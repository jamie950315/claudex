const REMOTE_ID = /^(?:cse_|session_)([A-Za-z0-9_-]{1,200})$/;
const MAX_DIAGNOSTICS = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim() && value.length <= 4096 ? value : null;

/** Normalize only the two observed spellings of the same native remote ID. */
export function normalizeClaudeRemoteId(value) {
  const match = typeof value === 'string' && REMOTE_ID.exec(value);
  return match ? `cse_${match[1]}` : null;
}

function canonicalPath(value, { allowTrailingSlash = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) return null;
  const path = allowTrailingSlash ? value.replace(/\/+$/, '') || '/' : value;
  if (path === '/') return path;
  const segments = path.slice(1).split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..') ? path : null;
}

/** The observed Claude Folder-key policy, for well-formed presentation rows.
 * This does not change a row's environment, identity, or native write route.
 */
export function claudeFolderProjectKey(row) {
  if (!object(row) || row.isScratchWorkspace || !object(row.repoInfo)) return undefined;
  const { owner, name } = row.repoInfo;
  if (!label(name) || owner !== undefined && typeof owner !== 'string') return undefined;
  if (owner) return `${owner}/${name}`.toLowerCase();
  if ((row.type === 'local' || row.type === 'cli') && typeof row.cwd === 'string' && row.cwd) {
    return row.cwd.replace(/[/\\]+$/, '');
  }
  if (row.type === 'bridge' && typeof row.environmentId === 'string' && row.environmentId) return `${row.environmentId}:${name}`;
  return name;
}

/** Build a read-only presentation override from already verified bridge data.
 *
 * `entries`: { remoteId, canonicalCwd, verified: true }[]. The caller must verify
 * the owner/ledger identity and canonical cwd; this pure helper performs no I/O
 * and cannot authenticate a caller's `verified` claim or resolve symlinks.
 * `localRows`: existing flat Claude presentation rows, not native registry data.
 * `groups`: optional existing { key, label }[] for exact rendered group labels.
 * `projectKey`: optional original native Folder-key function, before overrides.
 *
 * Only exact same-host local/CLI cwd or observed harness-root matches qualify.
 * Missing, ambiguous, or unverified targets produce no override. All original
 * rows, IDs, types, routes and history references remain untouched. A consumer
 * must use both projectKey and label: a remote row encountered first must not
 * seed a replacement label from its absent/different repoInfo.
 */
export function buildClaudeFolderProjection({ entries, localRows, groups, projectKey = claudeFolderProjectKey } = {}) {
  if (!Array.isArray(entries) || !Array.isArray(localRows) || groups !== undefined && !Array.isArray(groups)
    || typeof projectKey !== 'function') throw new Error('Folder projection requires verified entries and existing local presentation rows.');

  const targets = new Map();
  for (const row of localRows) {
    if (!object(row) || !['local', 'cli'].includes(row.type) || !label(row.id)
      || row.remote != null || row.isScratchWorkspace) continue;
    const paths = new Set(['cwd', 'diffCwd', 'harnessCwd'].map(field => canonicalPath(row[field], { allowTrailingSlash: true })).filter(Boolean));
    if (!paths.size) continue;
    const key = projectKey(row);
    if (!label(key)) continue;
    const groupLabel = label(row.repoInfo?.name);
    for (const path of paths) {
      const matches = targets.get(path) ?? [];
      matches.push({ key, label: groupLabel });
      targets.set(path, matches);
    }
  }

  const groupLabels = new Map();
  if (groups) for (const group of groups) {
    if (!object(group) || !label(group.key)) continue;
    const labels = groupLabels.get(group.key) ?? new Set();
    labels.add(label(group.label));
    groupLabels.set(group.key, labels);
  }

  const byRemote = new Map();
  const excluded = [];
  let excludedCount = 0;
  const exclude = (remoteId, reason) => {
    excludedCount++;
    if (excluded.length < MAX_DIAGNOSTICS) excluded.push(Object.freeze({ ...(remoteId ? { remoteId } : {}), reason }));
  };
  for (const entry of entries) {
    const remoteId = normalizeClaudeRemoteId(entry?.remoteId);
    if (!remoteId) { exclude(null, 'invalid_remote_id'); continue; }
    const candidates = byRemote.get(remoteId) ?? [];
    candidates.push(entry);
    byRemote.set(remoteId, candidates);
  }

  const overrides = Object.create(null);
  for (const [remoteId, candidates] of byRemote) {
    if (candidates.some(entry => !object(entry) || entry.verified !== true)) { exclude(remoteId, 'unverified_remote_id'); continue; }
    const paths = candidates.map(entry => canonicalPath(entry.canonicalCwd));
    if (paths.some(path => path === null)) { exclude(remoteId, 'invalid_canonical_cwd'); continue; }
    if (new Set(paths).size !== 1) { exclude(remoteId, 'conflicting_remote_mapping'); continue; }
    const matches = targets.get(paths[0]);
    if (!matches?.length) { exclude(remoteId, 'missing_existing_local_group'); continue; }
    const keys = new Set(matches.map(match => match.key));
    if (keys.size !== 1) { exclude(remoteId, 'ambiguous_existing_local_group'); continue; }
    const key = [...keys][0];
    const labels = groups ? groupLabels.get(key) : new Set(matches.map(match => match.label));
    if (!labels || labels.size !== 1 || labels.has(null)) { exclude(remoteId, 'missing_or_ambiguous_local_label'); continue; }
    overrides[remoteId] = Object.freeze({ projectKey: key, label: [...labels][0] });
  }
  return Object.freeze({ version: 1, overrides: Object.freeze(overrides), excludedCount, excluded: Object.freeze(excluded) });
}

/** Look up an override without changing the original presentation row. */
export function lookupClaudeFolderProjection(snapshot, remoteId) {
  const id = normalizeClaudeRemoteId(remoteId);
  return id && snapshot?.version === 1 && object(snapshot.overrides) && Object.hasOwn(snapshot.overrides, id)
    ? snapshot.overrides[id] : undefined;
}
