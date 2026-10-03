import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { containsWorkspacePath } from './collaboration-workspace.mjs';

export const MAX_ARTIFACT_READ_BYTES = 65536;
const fail = message => { throw Object.assign(new Error(message), { code: 'CLAUDEX_ARTIFACT_REFUSED' }); };
const execFileAsync = promisify(execFile);
const identity = info => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].map(key => [key, String(info[key])]));
const same = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
const sameDirectory = (a, b) => ['dev', 'ino', 'mode', 'uid'].every(key => a[key] === b[key]);

async function directoryChain(path) {
  const entries = [], root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Artifact directory chain must not contain symbolic links.');
    entries.push([cursor, info]);
  }
  return entries;
}

function declarations(task, generation) {
  const reports = [task.active?.report, task.lastExecution?.report,
    ...(Array.isArray(task.reports) ? task.reports : []), ...(Array.isArray(task.reportHistory) ? task.reportHistory : []),
    ...(Array.isArray(task.progress?.reports) ? task.progress.reports : [])];
  return reports.filter(report => report?.generation === generation).flatMap(report =>
    (report.artifacts ?? report.outcome?.artifacts ?? []).map(artifact => ({ artifact, report })));
}

/** The caller must first authorize this task through the broker. Even a task
 * with full-access execution only exposes declared files under explicit roots.
 * A read is a current file observation, never proof that this worker authored it. */
export async function readCollaborationArtifact(task, { generation, reference, maxBytes = MAX_ARTIFACT_READ_BYTES, view = 'content' } = {}, { now = Date.now } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > task.generation
    || typeof reference !== 'string' || !reference || reference.includes('\0') || Buffer.byteLength(reference) > 2048
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_READ_BYTES || !['content', 'diff'].includes(view))
    fail('Artifact reads require an exact generation, declared reference and bounded size.');
  const declaration = declarations(task, generation).find(({ artifact }) => artifact?.kind === 'file' && artifact.reference === reference);
  if (!declaration) fail('Artifact is not a declared file for this generation.');
  const roots = [...new Set([task.projectRoot ?? task.cwd, ...(task.readOnlyDirs ?? []), ...(task.writableDirs ?? [])])];
  if (roots.some(root => typeof root !== 'string' || !isAbsolute(root) || root === dirname(root)))
    fail('Artifact task roots are unavailable.');
  const path = resolve(task.cwd, reference);
  if (!roots.some(root => containsWorkspacePath(root, path))) fail('Artifact is outside the task directory grants.');
  // Canonical roots are revalidated independently of native execution permission.
  for (const root of roots) if (await realpath(root) !== root) fail('Artifact task root is no longer canonical.');
  const chain = await directoryChain(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))
    fail('Artifact must be an owned, single-link regular file.');
  if (before.size > BigInt(maxBytes)) fail('Artifact exceeds the bounded read size.');
  if (await realpath(path) !== path) fail('Artifact path is not canonical.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !same(before, opened)) fail('Artifact changed before reading.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (length > maxBytes || BigInt(length) !== opened.size || !same(opened, after) || !same(after, named))
      fail('Artifact changed while reading.');
    for (const [entry, info] of chain) if (!sameDirectory(info, await lstat(entry, { bigint: true })))
      fail('Artifact directory changed while reading.');
    if (await realpath(path) !== path) fail('Artifact path changed while reading.');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('Artifact is not UTF-8 text.'); }
  if (content.includes('\0')) fail('Binary artifacts are not supported by this text reader.');
  if (view === 'diff') {
    try {
      const result = await execFileAsync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true',
        'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', path], {
        cwd: dirname(path), timeout: 5000, maxBuffer: maxBytes,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      });
      content = result.stdout;
    } catch { fail('Bounded artifact diff is unavailable; the file must be in a Git worktree.'); }
    if (!same(before, await lstat(path, { bigint: true })) || await realpath(path) !== path)
      fail('Artifact changed during diff inspection.');
    for (const [entry, info] of chain) if (!sameDirectory(info, await lstat(entry, { bigint: true })))
      fail('Artifact directory changed during diff inspection.');
  }
  return { taskId: task.id, generation, reference, path, view, content, encoding: 'utf8', bytes: bytes.length,
    ...(view === 'diff' ? { comparison: 'working-tree-versus-index', diffBytes: Buffer.byteLength(content),
      limitation: 'An empty diff is not evidence of an unchanged or tracked file. Shared checkout changes have unknown authorship.' } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex'), observedAt: now(), identity: identity(before),
    provenance: 'file-observed', attribution: 'unknown',
    declaration: { generation, provenance: declaration.report.provenance ?? 'worker-self-reported' } };
}
