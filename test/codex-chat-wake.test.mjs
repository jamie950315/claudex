import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { preflightCodexChatWake, prepareCodexChatWake, codexPeerTurn } from '../src/codex-chat-wake.mjs';

const sessionId = randomUUID();
async function fixture(t, outcome = 'accepted') {
  const codexHome = await realpath(await mkdtemp(join(tmpdir(), 'cw-')));
  await mkdir(join(codexHome, 'ipc'), { mode: 0o700 });
  const path = join(codexHome, 'ipc', 'ipc.sock'), owner = randomUUID(), requests = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size); requests.push(request);
        let response = { type: 'response', requestId: request.requestId,
          resultType: 'success', method: request.method, handledByClientId: owner };
        if (request.method === 'initialize') response.result = { clientId: randomUUID() };
        else if (request.method === 'thread-owner-discovery') response.result = { supportsUntrustedAppInput: true };
        else if (outcome === 'disconnect') { socket.destroy(); continue; }
        else if (outcome === 'busy') response = { ...response, resultType: 'error', error: 'App context must wait until the current turn finishes' };
        else response.result = { result: { turn: { id: 'native-turn' } } };
        const data = Buffer.from(JSON.stringify(response)), head = Buffer.alloc(4); head.writeUInt32LE(data.length);
        socket.write(head.subarray(0, 2)); socket.write(Buffer.concat([head.subarray(2), data]));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(codexHome, { recursive: true, force: true }); });
  return { codexHome, requests, path };
}

test('peer message uses native untrusted tool context and inherits settings', () => {
  const payload = codexPeerTurn({ sessionId, messageId: 'message-1', text: 'Quoted peer request.' });
  assert.equal(payload.turnStart.context.inheritThreadSettings, true);
  assert.deepEqual(Object.keys(payload.turnStart.request).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(payload.turnStart.context.responseItems[0].name, 'untrusted_input');
  assert.match(payload.turnStart.request.input[0].text_elements[0].placeholder, /^codex-untrusted-app-input:/);
  assert.equal(JSON.parse(payload.turnStart.context.responseItems[1].output[0].text).text, 'Quoted peer request.');
});

test('discovery is read-only; dispatch rechecks exact owner and is one-use', async t => {
  const f = await fixture(t), handle = await preflightCodexChatWake({ sessionId, codexHome: f.codexHome });
  assert.equal(handle.status, 'ready');
  assert.deepEqual(f.requests.map(r => r.method), ['initialize', 'thread-owner-discovery']);
  assert.deepEqual(await handle.dispatch({ messageId: 'm', text: 'Peer text' }), { status: 'accepted', turnId: 'native-turn' });
  const dispatch = f.requests.at(-1);
  assert.equal(dispatch.method, 'thread-follower-start-turn'); assert.equal(dispatch.version, 2);
  assert.equal(dispatch.targetClientId, handle.ownerClientId);
  assert.equal(f.requests.at(-2).targetClientId, handle.ownerClientId);
  await assert.rejects(handle.dispatch({ messageId: 'm', text: 'Peer text' }), /already been used/);
});

test('native busy refusal is explicit and never steers a running turn', async t => {
  const f = await fixture(t, 'busy'), handle = await preflightCodexChatWake({ sessionId, codexHome: f.codexHome });
  assert.equal((await handle.dispatch({ messageId: 'm', text: 'Peer text' })).status, 'busy');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('lost dispatch response is uncertain with no replay', async t => {
  const f = await fixture(t, 'disconnect'), handle = await preflightCodexChatWake({ sessionId, codexHome: f.codexHome });
  assert.equal((await handle.dispatch({ messageId: 'm', text: 'Peer text' })).status, 'uncertain');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('public socket permissions are refused before connecting', async t => {
  const f = await fixture(t); await chmod(f.path, 0o666);
  await assert.rejects(preflightCodexChatWake({ sessionId, codexHome: f.codexHome }), /not private/);
  assert.equal(f.requests.length, 0);
});

test('loaded owner does not navigate or dispatch', async () => {
  const handle = { status: 'ready' };
  assert.equal(await prepareCodexChatWake({ sessionId }, {
    preflight: async () => handle,
    open: () => assert.fail('Unexpected Desktop navigation'),
  }), handle);
});

test('cold owner is opened exactly once without prompt and then discovered', async () => {
  const opens = [], probes = [];
  let clock = 0;
  const handle = { status: 'ready' };
  const result = await prepareCodexChatWake({ sessionId }, {
    preflight: async options => {
      probes.push(options);
      if (probes.length === 1) throw Object.assign(new Error('Discovery timeout'), { code: 'CODEX_OWNER_DISCOVERY_TIMEOUT' });
      return probes.length === 3 ? handle : { status: 'unavailable', reason: 'native-owner-unavailable' };
    },
    open: async url => opens.push(url), wait: async ms => { clock += ms; }, now: () => clock,
  });
  assert.equal(result, handle);
  assert.deepEqual(opens, [`codex://threads/${sessionId}`]);
  assert.equal(probes.length, 3);
  assert.ok(probes.every(p => p.sessionId === sessionId));
});

test('cold owner checks stop after bounded discovery window with no dispatch', async () => {
  let clock = 0, opened = 0, probes = 0;
  const result = await prepareCodexChatWake({ sessionId }, {
    preflight: async () => { probes++; return { status: 'unavailable', reason: 'desktop-not-running' }; },
    open: async () => { opened++; }, wait: async ms => { clock += ms; }, now: () => clock,
  });
  assert.equal(result.reason, 'native-owner-unavailable-after-open');
  assert.equal(opened, 1); assert.equal(clock, 10000); assert.ok(probes <= 41);
});

test('malformed private endpoint and initialization timeout never trigger navigation', async () => {
  for (const error of [new Error('Noncanonical endpoint'), new Error('Codex Desktop IPC request timed out.')]) {
    await assert.rejects(prepareCodexChatWake({ sessionId }, {
      preflight: async () => { throw error; }, open: () => assert.fail('Unexpected Desktop navigation'),
    }), candidate => candidate === error);
  }
});
