// Read-only native capability/usage probe. There is deliberately no dispatch mode.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { codexChatSocket } from '../../src/native-chat-catalog.mjs';
import { CodexWebSocketClient } from '../../src/codex-websocket.mjs';
import { preflightCodexChatWake } from '../../src/codex-chat-wake.mjs';
import { createCodexUsageCounter, codexCacheAdmission } from './codex-usage.mjs';

const { values } = parseArgs({ options: { session: { type: 'string' }, 'observe-ms': { type: 'string', default: '0' } } });
const id = values.session ?? process.env.CODEX_THREAD_ID;
const duration = Number(values['observe-ms']);
assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? ''), 'Supply an exact --session UUID.');
assert(Number.isSafeInteger(duration) && duration >= 0 && duration <= 60000, 'observe-ms must be 0 through 60000.');
let owner, client, timer;
const report = { admission: null, nativeVersion: null, configuredModel: null,
  observations: { baseline: 0, duplicate: 0, sample: 0 }, rawUsageEvents: 0,
  observedUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  inferenceStartedByProbe: false, historiesRead: false, nativeSettingsChanged: false };
try {
  owner = await preflightCodexChatWake({ sessionId: id });
  report.admission = codexCacheAdmission(owner);
  owner.close?.(); owner = null;
  client = new CodexWebSocketClient({ socketPath: await codexChatSocket(), timeoutMs: 5000 });
  const initialized = await client.initialize();
  report.nativeVersion = initialized.userAgent;
  const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
  assert.equal(thread.id, id);
  report.configuredModel = thread.model;
  if (duration) {
    const loaded = await client.request('thread/loaded/list', {});
    assert(loaded.data?.includes(id) && thread.status?.type === 'active',
      'Usage observation requires an already-loaded active thread; no offline resume is allowed.');
    const counter = createCodexUsageCounter(id);
    let usageError, finish;
    const done = new Promise(resolve => { finish = resolve; timer = setTimeout(resolve, duration); });
    client.on('disconnected', () => { usageError = new Error('Native observation disconnected.'); finish(); });
    client.on('notification', event => {
      if (event.params?.threadId !== id) return;
      if (event.method === 'rawResponse/completed') report.rawUsageEvents++;
      if (['thread/compacted', 'model/rerouted', 'thread/closed'].includes(event.method)) {
        usageError = new Error('Native context changed; usage observation stopped.'); finish(); return;
      }
      if (event.method !== 'thread/tokenUsage/updated') return;
      try {
        const sample = counter.observe(event.params);
        report.observations[sample.state]++;
        if (sample.state === 'sample') for (const key of Object.keys(report.observedUsage)) report.observedUsage[key] += sample.usage[key];
      } catch (error) { usageError = error; finish(); }
    });
    // The documented running-thread path rejoins its existing native owner.
    // No configuration override, new thread, turn/start or model prompt is sent.
    await client.request('thread/resume', { threadId: id, excludeTurns: true });
    console.log(JSON.stringify({ observingExistingActiveThread: true, automaticDispatch: false }));
    await done;
    if (usageError) throw usageError;
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { clearTimeout(timer); owner?.close?.(); await client?.close(); console.log(JSON.stringify(report, null, 2)); }
