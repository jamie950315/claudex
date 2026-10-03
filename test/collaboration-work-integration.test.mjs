import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { serveCollaborationSocket, runCollaborationMcp } from '../src/collaboration-transport.mjs';

async function until(check) {
  for (let n = 0; n < 300; n++) { const result = await check(); if (result) return result; await delay(5); }
  throw new Error('Synthetic work flow did not reach its boundary.');
}

test('MCP and Unix RPC expose exact work evidence, blocker decision and next-generation instruction adoption', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cwi-')));
  await chmod(directory, 0o700);
  const root = join(directory, 'collaboration');
  const artifact = join(directory, 'result.txt'); await writeFile(artifact, 'synthetic artifact\n', { mode: 0o600 });
  const sessions = [], gates = [];
  let hub;
  const mcp = async (name, args, token = hub.controllerToken, peer = 'codex') => {
    const input = new PassThrough(), output = new PassThrough(); let wire = '';
    output.on('data', bytes => { wire += bytes; });
    const serving = runCollaborationMcp({ root, token, peer, input, output });
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    await serving;
    const result = JSON.parse(wire.trim()).result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  hub = await new CollaborationHub({ root,
    originVerifier: async p => ({ provider: p.provider, sessionId: p.sessionId, cwd: p.cwd,
      toolUseId: p.toolUseId, source: 'synthetic-native-proof', verifiedAt: Date.now() }),
    mcp: async ({ token }) => ({ token }),
    run: async options => {
      sessions.push(options);
      return new Promise(resolve => { gates.push(resolve); });
    },
  }).initialize();
  const server = await serveCollaborationSocket({ root, dispatch: envelope => hub.dispatch(envelope) });
  t.after(async () => { for (const resolve of gates) resolve({ text: 'Synthetic cleanup' }); await hub.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await hub.chatMailbox.hook({ provider: 'codex', sessionId, cwd: directory, event: 'SessionStart' });
  const start = await mcp('claudex_start', { provider: 'claude', cwd: directory, prompt: 'Synthetic work', requestId: 'start',
    observability: { timeline: 'public', reports: 'milestones', blockerNotifications: true }, notifications: { mode: 'queue' } });
  const taskId = start.taskId;
  await until(() => sessions.length === 1);
  await hub.dispatch({ peer: 'codex', token: hub.controllerToken, method: 'origin_bind', params: {
    taskId, sessionId, cwd: directory, toolUseId: 'synthetic-start' } });
  const worker = (name, args) => mcp(name, args, sessions.at(-1).mcp.token, 'claude');
  const initial = await mcp('claudex_status', { taskId, view: 'summary' });
  await sessions[0].onWorkEvent({ kind: 'assistant-message', source: 'native:claude', nativeId: 'public-1',
    text: 'Public work message', granularity: 'message' });
  const report = { outcome: 'needs-input', summary: 'One synthetic decision is needed.', stage: 'validation', next: 'Use the exact response.',
    blocker: { id: 'decision', question: 'Which fixture?', impact: 'Validation cannot finish.', needs: 'Choose A.' },
    artifacts: [{ kind: 'file', reference: artifact }], checks: [{ name: 'Fixture read', result: 'passed' }] };
  await worker('claudex_report', { taskId, requestId: 'report', report });
  await until(() => hub.state.tasks[taskId].notification.deliveries[0]?.state === 'queued');
  const beforeReads = await mcp('claudex_status', { taskId, view: 'summary' });
  assert.ok(beforeReads.revision > initial.revision);
  const events = await mcp('claudex_work_events', { taskId, generation: 1 });
  assert.ok(events.events.some(e => e.text === 'Public work message'));
  const reports = await mcp('claudex_work_reports', { taskId, generation: 1 });
  assert.equal(reports.reports[0].checks[0].result, 'passed');
  assert.equal(reports.reports[0].provenance, 'worker-self-reported');
  const observed = await mcp('claudex_artifact_read', { taskId, generation: 1, reference: artifact });
  assert.equal(observed.content, 'synthetic artifact\n'); assert.equal(observed.attribution, 'unknown');
  assert.equal((await mcp('claudex_status', { taskId, view: 'summary' })).revision, beforeReads.revision);
  const response = await mcp('claudex_work_control', { taskId, generation: 1, action: 'respond-blocker', blockerId: 'decision',
    text: 'Use A within the original permissions.', requestId: 'decision-response' });
  assert.equal(hub.state.tasks[taskId].instructions[0].state, 'queued');
  gates[0]({ text: 'Synthetic first completed boundary.' });
  await until(() => sessions.length === 2);
  assert.equal(hub.state.tasks[taskId].instructions[0].generation, 2);
  assert.equal(hub.state.tasks[taskId].instructions[0].state, 'delivered');
  await worker('claudex_work_control', { taskId, generation: 2, action: 'ack-instruction', instructionId: response.instructionId,
    decision: 'accepted', requestId: 'adopt' });
  assert.equal(hub.state.tasks[taskId].instructions[0].state, 'accepted');
  assert.equal(hub.state.tasks[taskId].instructions[0].acknowledgmentProvenance, 'worker-self-reported');
  gates[1]({ text: 'Synthetic final answer.' });
  await until(() => hub.state.tasks[taskId].status === 'completed');
  const final = await mcp('claudex_status', { taskId, view: 'summary' });
  assert.equal(final.resultFinal, true); assert.equal(final.generation, 2);
  assert.equal(hub.state.tasks[taskId].notification.deliveries.filter(d => d.kind === 'blocker').length, 1);
  assert.equal((await mcp('claudex_work_events', { taskId, generation: 1, cursor: events.cursor })).events
    .filter(e => e.nativeId === 'public-1').length, 0);
});
