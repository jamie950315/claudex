import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readDesktopSessionMappings } from './desktop.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINES = 100_000;
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);
const validTitle = value => typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const identity = chat => chat.nativeId ?? chat.sessionId;

async function readCodexTitles(root, wanted) {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Codex metadata root must be canonical.');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || await realpath(root) !== root)
    throw new Error('Codex metadata root is not a canonical owned directory.');
  const path = join(root, 'session_index.jsonl');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.nlink !== 1 || before.size > MAX_BYTES)
    throw new Error('Codex session index is not a bounded owned regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content;
  try {
    if (!same(before, await file.stat())) throw new Error('Codex session index changed while opening.');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== before.size || !same(before, await file.stat()) || !same(before, await lstat(path))
      || !same(directory, await lstat(root)) || await realpath(root) !== root)
      throw new Error('Codex session index changed while reading.');
    content = bytes.subarray(0, length).toString('utf8');
  } finally { await file.close(); }
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) throw new Error('Codex session index exceeds the line limit.');
  const result = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Malformed Codex session index.'); }
    if (!row || typeof row.id !== 'string' || !wanted.has(row.id.toLowerCase())) continue;
    const id = row.id.toLowerCase();
    const time = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
    if (!validTitle(row.thread_name) || !Number.isFinite(time)) throw new Error('Codex session index lacks valid title or update metadata.');
    const previous = result.get(id);
    if (!previous || time > previous.time) result.set(id, { title: row.thread_name, time, ambiguous: false });
    else if (time === previous.time && row.thread_name !== previous.title) previous.ambiguous = true;
  }
  return result;
}

/** Enrich only registered identities; metadata never enrolls or retargets a chat. */
export async function enrichChatTitles(chats, {
  codexHome = join(homedir(), '.codex'),
  desktopHome = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
} = {}) {
  const result = chats.map(chat => {
    const value = { ...chat, title: null, titleSource: null };
    delete value.titleError;
    delete value.archived;
    if (chat.nativeId && chat.sessionId && chat.nativeId !== chat.sessionId)
      value.titleError = 'Registered chat identities disagree.';
    return value;
  });
  for (const provider of ['codex', 'claude']) {
    const selected = result.filter(chat => chat.provider === provider && !chat.titleError && UUID.test(identity(chat) ?? ''));
    if (!selected.length) continue;
    const wanted = new Set(selected.map(chat => identity(chat).toLowerCase()));
    let metadata;
    try {
      metadata = provider === 'codex' ? await readCodexTitles(codexHome, wanted)
        : await readDesktopSessionMappings(desktopHome, [...wanted]);
    } catch (error) {
      const reason = error.code === 'ENOENT' ? `${provider} title metadata is unavailable.` : error.message;
      for (const chat of selected) chat.titleError = reason;
      continue;
    }
    for (const chat of selected) {
      const entry = metadata.get(identity(chat).toLowerCase());
      if (!entry) { chat.titleError = `${provider} title metadata has no matching native session.`; continue; }
      if (entry.ambiguous) { chat.titleError = 'Conflicting Codex titles have the same update timestamp.'; continue; }
      chat.title = entry.title;
      chat.titleSource = provider === 'codex' ? 'codex-session-index' : 'claude-desktop-registry';
      if (provider === 'claude') {
        chat.archived = entry.isArchived;
        if (entry.cwd !== chat.cwd) chat.titleError = 'Desktop project differs from the registered chat; refresh its native hook registration.';
      }
    }
  }
  return result;
}
