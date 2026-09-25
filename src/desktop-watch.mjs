import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexSessionId, discoverSources, isCodexSubagentSource } from './discovery.mjs';
import { withLock, writeJSON } from './storage.mjs';

const WAITING = /still running|complete assistant|no completed persisted history|in-progress turn|unfinished|incomplete final|incomplete final line|empty or invalid conversation|transcript changed while being read|source history changed between complete reads|active writer|destination is active|Claude turn is still running|Claude Code is open|another bridge operation|shared Codex Desktop backend is not ready|shared Codex transport (?:closed|failed|is not connected)|could not connect to the shared Codex transport|transport unavailable|socket.*(?:unavailable|closed|disconnected)|ECONNREFUSED|ECONNRESET|ENOENT.*socket/i;
const UNSUPPORTED = /Codex compaction|Compacted Codex history|Referenced Codex history|Claude compaction|Dependent Claude history|Nonlinear Claude history|Missing or dependent Codex history|working directory changed|turn was interrupted|Unsupported message role|Duplicate open tool call|Unpaired tool result|External image references|Artifact handoffs/i;
const reason = error => String(error?.message ?? error).slice(0, 500);
const isWaiting = error => WAITING.test(reason(error));
const isUnsupported = error => UNSUPPORTED.test(reason(error));

/** Run the opt-in Desktop coordinator under the same lock as the legacy watcher. */
export async function runDesktopWatch({ root, bridge, runtime, config, signal, pollMs = 2000,
  discover = discoverSources, sleep = (ms, options) => delay(ms, undefined, options),
  now = () => Date.now(), maxPasses = Infinity }) {
  if (!root || !bridge || !runtime || !config) throw new Error('Desktop watcher requires root, bridge, runtime, and discovery configuration.');
  if (!Number.isInteger(pollMs) || pollMs < 0 || !(maxPasses > 0)) throw new Error('Invalid Desktop watcher interval or pass limit.');
  const statusPath = join(root, 'watcher-status.json');
  const startedAt = now();
  let lastCollection = startedAt;
  let passes = 0;
  const status = fields => writeJSON(statusPath, { mode: 'desktop', running: true, pid: process.pid,
    startedAt, updatedAt: now(), ...fields });
  return withLock(join(root, 'watch.lock'), async () => {
    await status({ waiting: null, blockedSourceCount: 0, blockedSources: [] });
    try {
      while (!signal?.aborted && passes++ < maxPasses) {
        let waiting = null;
        let blockedSourceCount = 0;
        const blockedSources = [];
        try {
          // The transport is a prerequisite. Never enroll a source while it is absent.
          const codex = await runtime.codex();
          let state = await bridge.status();
          if (state.pending) await bridge.recover();
          state = await bridge.status();
          const known = new Set(state.records.map(record => `${record.side}:${record.nativeId}`));
          for (const id of await runtime.ownedNativeIds()) known.add(id);
          const candidates = await discover({ ...config, allProjects: true, projects: [], excludeSubagents: false }, known);
          for (const source of candidates) {
            if (signal?.aborted) break;
            try {
              if (source.side === 'codex') {
                const nativeId = source.nativeId ?? source.id ?? await codexSessionId(source.path);
                const metadata = (await codex.request('thread/read', { threadId: nativeId, includeTurns: false }).catch(error => {
                  if (/not found|no rollout/i.test(reason(error))) throw new Error('Referenced Codex history is unavailable.');
                  throw error;
                }))?.thread;
                if (!metadata || metadata.id !== nativeId) throw new Error('Codex returned a different native identity.');
                if (isCodexSubagentSource(metadata.source)) continue;
              }
              await bridge.track(source);
              // Discovery can return duplicate paths for one native identity.
              const latest = await bridge.status();
              for (const record of latest.records) known.add(`${record.side}:${record.nativeId}`);
            } catch (error) {
              if (isWaiting(error)) { waiting ??= reason(error); continue; }
              if (!isUnsupported(error)) throw error;
              blockedSourceCount++;
              if (blockedSources.length < 20) blockedSources.push({ side: source.side, path: source.path, reason: reason(error) });
            }
          }
          state = await bridge.status();
          for (const id of Object.keys(state.conversations)) {
            if (signal?.aborted) break;
            try { await bridge.sync(id); }
            catch (error) {
              // A native write may have committed before its response failed. Recover
              // its durable intent and verify the native target before proceeding.
              if ((await bridge.status()).pending) {
                try { await bridge.recover(); }
                catch (recoveryError) {
                  if (isWaiting(recoveryError)) { waiting ??= reason(recoveryError); continue; }
                  throw recoveryError;
                }
                continue;
              }
              if (isWaiting(error)) { waiting ??= reason(error); continue; }
              throw error;
            }
          }
          if (!signal?.aborted && now() - lastCollection >= 60_000) {
            await bridge.collect();
            lastCollection = now();
          }
        } catch (error) {
          if (!isWaiting(error)) throw error;
          waiting ??= reason(error);
        }
        await status({ waiting, blockedSourceCount, blockedSources });
        if (!signal?.aborted && passes < maxPasses) {
          try { await sleep(pollMs, { signal }); }
          catch (error) { if (error.name !== 'AbortError' || !signal?.aborted) throw error; }
        }
      }
      await writeJSON(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: null });
    } catch (error) {
      await writeJSON(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: reason(error) });
      // A busy ClaudeOwner must keep its live handle; closing it can interrupt user work.
      throw error;
    }
  }, { recoverDead: true });
}
