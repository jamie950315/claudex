import { lstat, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
const MAX_ROOTS = 16;

export function containsWorkspacePath(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export const pathContains = containsWorkspacePath;

const overlaps = (left, right) => containsWorkspacePath(left, right) || containsWorkspacePath(right, left);
const compact = roots => [...new Set(roots)].filter((root, _, all) =>
  !all.some(other => other !== root && containsWorkspacePath(other, root))).sort();

async function directory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || Buffer.byteLength(value) > 4096)
    throw new Error(`${label} must be an absolute directory path.`);
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be an existing directory.`);
  return canonical;
}

async function directories(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ROOTS) throw new Error(`${label} must contain at most ${MAX_ROOTS} directories.`);
  return compact(await Promise.all(value.map(path => directory(path, label))));
}

async function projectDirectory(cwd) {
  for (let cursor = cwd; ; cursor = dirname(cursor)) {
    let marker;
    try { marker = await lstat(join(cursor, '.git')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker) {
      if (!marker.isDirectory() && !marker.isFile()) throw new Error('Project Git marker must be a regular file or directory.');
      if (marker.isFile()) {
        if (marker.size > 8192) throw new Error('Project Git marker exceeds the size limit.');
        const handle = await open(join(cursor, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try {
          const before = await handle.stat();
          const buffer = Buffer.alloc(8193);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const after = await handle.stat();
          if (!before.isFile() || before.dev !== marker.dev || before.ino !== marker.ino
              || bytesRead > 8192 || before.size !== bytesRead || after.size !== before.size
              || after.mtimeMs !== before.mtimeMs)
            throw new Error('Project Git marker changed during inspection.');
          content = buffer.toString('utf8', 0, bytesRead);
        } finally { await handle.close(); }
        const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(content);
        if (!match) throw new Error('Project Git marker has an unsupported format.');
        await directory(resolve(cursor, match[1]), 'Git metadata directory');
      }
      const root = cursor;
      const home = await realpath(homedir());
      return root === dirname(root) || root === home ? cwd : root;
    }
    if (cursor === dirname(cursor)) return cwd;
  }
}

/** Access roots for both scoped tasks and legacy tasks (which retain exact cwd). */
export function workspaceAccess(task) {
  const primary = task.projectRoot ?? task.cwd;
  const readRoots = [primary, ...(task.readOnlyDirs ?? [])];
  const writeRoots = task.permission === 'workspace-write' ? [primary, ...(task.writableDirs ?? [])] : [];
  return { readRoots: compact([...readRoots, ...writeRoots]), writeRoots: compact(writeRoots) };
}

/** Canonicalize authorization once; children never discover a broader Git root. */
export async function resolveCollaborationWorkspace({ cwd, projectRoot, readOnlyDirs, writableDirs, permission = 'read-only', parent } = {}) {
  if (!['read-only', 'workspace-write'].includes(permission)) throw new Error('Unsupported workspace permission.');
  if (parent) await revalidateWorkspace(parent);
  const requested = await directory(cwd ?? parent?.cwd, 'cwd');
  const primary = projectRoot !== undefined ? await directory(projectRoot, 'projectRoot')
    : parent ? (cwd === undefined || requested === parent.cwd ? parent.projectRoot ?? parent.cwd : requested)
      : await projectDirectory(requested);
  if (!containsWorkspacePath(primary, requested)) throw new Error('projectRoot must contain cwd.');
  const parentAccess = parent && workspaceAccess(parent);
  if (parentAccess && !parentAccess.readRoots.some(root => containsWorkspacePath(root, primary)))
    throw new Error('Child projectRoot exceeds parent directory access.');
  if (parentAccess && permission === 'workspace-write'
      && !parentAccess.writeRoots.some(root => containsWorkspacePath(root, primary)))
    throw new Error('Child workspace-write permission exceeds parent directory access.');
  const inheritedReads = parent?.readOnlyDirs ?? [];
  const inheritedWrites = parent?.writableDirs ?? [];
  let reads = await directories(readOnlyDirs ?? (permission === 'read-only' ? [...inheritedReads, ...inheritedWrites] : inheritedReads), 'readOnlyDirs');
  const writes = await directories(writableDirs ?? (permission === 'workspace-write' ? inheritedWrites : []), 'writableDirs');
  if (permission === 'read-only' && writes.length) throw new Error('read-only work cannot request writableDirs.');
  const writeRoots = permission === 'workspace-write' ? compact([primary, ...writes]) : [];
  const allRoots = [primary, ...reads, ...writes];
  if (allRoots.some(root => root === dirname(root))) throw new Error('Filesystem root cannot be a workspace access grant.');
  const home = await realpath(homedir());
  if (writeRoots.some(root => containsWorkspacePath(root, home))) throw new Error('Workspace write access must not cover the entire home directory.');
  if (reads.some(root => writeRoots.some(write => overlaps(root, write))))
    throw new Error('readOnlyDirs must not overlap a writable workspace directory.');
  if (parentAccess) {
    if (reads.some(root => !parentAccess.readRoots.some(allowed => containsWorkspacePath(allowed, root)))
        || writes.some(root => !parentAccess.writeRoots.some(allowed => containsWorkspacePath(allowed, root))))
      throw new Error('Child directories exceed parent directory access.');
  }
  // The primary read-only scope already grants contained reference directories.
  if (permission === 'read-only') reads = reads.filter(root => !containsWorkspacePath(primary, root));
  return { cwd: primary, projectRoot: primary, readOnlyDirs: reads,
    writableDirs: writes.filter(root => !containsWorkspacePath(primary, root)) };
}

/** Detect shared reader/writer roots for callers; this does not impose a scheduler lock. */
export function workspacesConflict(left, right) {
  const a = workspaceAccess(left), b = workspaceAccess(right);
  return a.writeRoots.some(root => b.readRoots.some(other => overlaps(root, other)))
    || b.writeRoots.some(root => a.readRoots.some(other => overlaps(root, other)));
}

/** Dispatch checks saved canonical grants, never re-detects or expands them. */
export async function revalidateWorkspace(task) {
  if (!['read-only', 'workspace-write'].includes(task.permission)) throw new Error('Unsupported workspace permission.');
  if (task.projectRoot !== undefined && task.projectRoot !== task.cwd)
    throw new Error('Saved projectRoot must match the effective working directory.');
  for (const key of ['readOnlyDirs', 'writableDirs']) {
    if (task[key] !== undefined && (!Array.isArray(task[key]) || task[key].length > MAX_ROOTS))
      throw new Error(`${key} must contain at most ${MAX_ROOTS} directories.`);
  }
  if (task.permission === 'read-only' && task.writableDirs?.length)
    throw new Error('read-only work cannot request writableDirs.');
  for (const path of new Set([task.cwd, task.projectRoot ?? task.cwd, ...(task.readOnlyDirs ?? []), ...(task.writableDirs ?? [])])) {
    if (await directory(path, 'Saved workspace directory') !== resolve(path))
      throw new Error('Saved workspace directory changed its canonical identity.');
  }
  const access = workspaceAccess(task);
  if ((task.readOnlyDirs ?? []).some(root => access.writeRoots.some(write => overlaps(root, write))))
    throw new Error('Saved read-only directories overlap writable access.');
}
