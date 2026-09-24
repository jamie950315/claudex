import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { projectDirectory } from './claude.mjs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function* codexFiles(path) {
  for (const entry of await entries(path)) {
    if (entry.isDirectory()) yield* codexFiles(join(path, entry.name));
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) yield join(path, entry.name);
  }
}

async function header(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) { try { return JSON.parse(line); } catch { return null; } }
    return null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { lines.close(); stream.destroy(); }
}

async function claudeCwd(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let cwd = null;
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.type === 'claudex-owner') return null;
        cwd ??= row.cwd;
      } catch { return null; }
    }
    return cwd;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { lines.close(); stream.destroy(); }
}

async function recent(path, since) {
  try { return (await stat(path)).mtimeMs >= since; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Discover only new activity in explicitly selected canonical project paths. */
export async function discoverSources({ codexHome, claudeHome, projects, since }, known = new Set()) {
  const selected = new Set(projects.map(path => resolve(path)));
  const sources = [];
  for await (const path of codexFiles(join(codexHome, 'sessions'))) {
    if (!(await recent(path, since))) continue;
    const row = await header(path);
    if (row?.type !== 'session_meta' || row.payload.originator === 'claudex') continue;
    if (!selected.has(row.payload.cwd) || known.has(`codex:${row.payload.id}`)) continue;
    sources.push({ side: 'codex', path });
  }
  for (const cwd of selected) {
    const directory = projectDirectory(claudeHome, cwd);
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.jsonl$/i.test(entry.name)) continue;
      if (known.has(`claude:${entry.name.slice(0, -6)}`)) continue;
      const path = join(directory, entry.name);
      // Different project paths can encode to the same Claude directory key.
      if (await recent(path, since) && await claudeCwd(path) === cwd) sources.push({ side: 'claude', path });
    }
  }
  return sources;
}
