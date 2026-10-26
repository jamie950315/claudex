import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../plugins/claudex/hooks/register.mjs';
const OP = '11111111-1111-4111-8111-111111111111';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const TEXT = '44444444-4444-4444-8444-444444444444';
function fixture({ kind = 'append', worker = false, fail = null, size = 70000, name = 'claudex-sync' } = {}) {
  const hooks = [], calls = [], appends = [];
  register((...args) => hooks.push(args), { stateRoot: '/fixture/state' });
  let session = SESSION;
  const content = [{ type: 'text', text: `START${'x'.repeat(size)}END` }, { type: 'text', text: 'tail' }];
  const $ = {
    env: { get: async () => worker ? '1' : undefined }, plugin: { root: '/fixture/plugin', name: 'claudex' },
    session: { id: async () => session, cwd: async () => '/fixture/project', append: async input => { appends.push(input); if (fail === 'append') throw new Error('uncertain'); return { uuid: TEXT }; } },
    process: { run: async (argv, options) => {
      calls.push({ argv, request: JSON.parse(options.stdin) });
      if (fail === argv[2]) throw new Error('unavailable');
      if (fail === 'lifecycle') session = OP;
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === 'receive' ? { ready: true, kind, content: kind === 'append' ? content : [] } : { recorded: true } }) };
    } },
  };
  $.process.spawn = async function* ({ argv, input }) {
    const reply = await $.process.run(argv, { stdin: input });
    for (let index = 0; index < reply.stdout.length; index += 65536) yield { stream: 'stdout', text: reply.stdout.slice(index, index + 65536) };
    return { code: reply.exitCode, signal: null };
  };
  const command = hooks.find(([event, filter]) => event === 'command.run' && filter.command === name)[2];
  return { command: args => command($, { args }), $, calls, appends, content };
}
test('Local Mod appends complete text once and acknowledges the minted native UUID', async () => {
  const f = fixture(); assert.deepEqual(await f.command(`${OP} ${CLAIM}`), { text: `CLAUDEX_SYNC_APPLIED ${OP}` });
  assert.deepEqual(f.appends, [{ message: { type: 'user', content: f.content } }]);
  assert.deepEqual(f.calls.map(c => c.argv), [
    ['/fixture/plugin/runtime/bin/claudex', 'local-sync', 'receive', '--root', '/fixture/state'],
    ['/fixture/plugin/runtime/bin/claudex', 'local-sync', 'applied', '--root', '/fixture/state'],
  ]);
  assert.equal(f.calls[1].request.textUuid, TEXT);
  assert.equal(f.calls[0].request.pluginName, 'claudex');
});
test('Local adoption acknowledges native context without replaying any seed text', async () => {
  const f = fixture({ kind: 'adopt' }); assert.equal((await f.command(`${OP} ${CLAIM}`)).text, `CLAUDEX_SYNC_APPLIED ${OP}`);
  assert.equal(f.appends.length, 0); assert.equal(f.calls[1].request.textUuid, null);
});
test('uncertain receive, append or receipt is consumed locally and never retried', async () => {
  for (const fail of ['receive', 'append', 'applied', 'lifecycle']) {
    const f = fixture({ fail }); assert.match((await f.command(`${OP} ${CLAIM}`)).text, /^CLAUDEX_SYNC_BLOCKED:/);
    assert.equal(f.calls.filter(c => c.argv[2] === 'receive').length, 1);
    assert.ok(f.appends.length <= 1);
    if (fail === 'receive' || fail === 'lifecycle') assert.equal(f.appends.length, 0);
  }
});
test('workers and malformed envelopes cannot borrow the local synchronization helper', async () => {
  const worker = fixture({ worker: true }); assert.match((await worker.command(`${OP} ${CLAIM}`)).text, /^CLAUDEX_SYNC_BLOCKED:/); assert.equal(worker.calls.length, 0);
  const f = fixture(); for (const value of ['', OP, `${OP} ${CLAIM} extra`, `text ${CLAIM}`]) assert.match((await f.command(value)).text, /^CLAUDEX_SYNC_BLOCKED:/);
  assert.equal(f.calls.length, 0);
});

test('streaming receive retains text beyond native process.run 4 MiB stdout bound', async () => {
  const f = fixture({ size: 5 * 1024 * 1024 });
  assert.equal((await f.command(`${OP} ${CLAIM}`)).text, `CLAUDEX_SYNC_APPLIED ${OP}`);
  assert.equal(f.appends[0].message.content[0].text, f.content[0].text);
});

test('native bootstrap records only actual context without appending text or invoking a model', async () => {
  const f = fixture({ name: 'claudex-bootstrap' });
  assert.deepEqual(await f.command(`${OP} ${CLAIM}`), { text: `CLAUDEX_LOCAL_READY ${OP}` });
  assert.equal(f.appends.length, 0); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { argv: ['/fixture/plugin/runtime/bin/claudex', 'local-sync', 'bootstrap', '--root', '/fixture/state'],
    request: { opId: OP, claimId: CLAIM, sessionId: SESSION, cwd: '/fixture/project', pluginName: 'claudex' } });
});
test('native bootstrap failures and malformed inputs are always consumed locally', async () => {
  for (const option of [{ fail: 'bootstrap' }, { fail: 'lifecycle' }, { worker: true }]) {
    const f=fixture({ ...option, name:'claudex-bootstrap' });
    assert.match((await f.command(`${OP} ${CLAIM}`)).text,/^CLAUDEX_LOCAL_BLOCKED:/);
    assert.equal(f.appends.length,0);
  }
  const f=fixture({ name:'claudex-bootstrap' });
  for(const args of ['',OP,`${OP} ${CLAIM} extra`])assert.match((await f.command(args)).text,/^CLAUDEX_LOCAL_BLOCKED:/);
  assert.equal(f.calls.length,0);
});

test('independent own-context witness uses only its dedicated helper, never bootstrap or append', async () => {
  const f=fixture({ name:'claudex-witness' });
  assert.deepEqual(await f.command(`${OP} ${CLAIM}`),{text:`CLAUDEX_LOCAL_WITNESSED ${OP}`});
  assert.equal(f.appends.length,0);
  assert.deepEqual(f.calls,[{argv:['/fixture/plugin/runtime/bin/claudex','local-sync','witness','--root','/fixture/state'],
    request:{opId:OP,claimId:CLAIM,sessionId:SESSION,cwd:'/fixture/project',pluginName:'claudex'}}]);
});
test('identity command failures expose only a fixed phase, always consuming the command', async () => {
  for(const name of ['claudex-bootstrap','claudex-witness']) {
    const marker=name==='claudex-bootstrap'?'CLAUDEX_LOCAL_BLOCKED':'CLAUDEX_WITNESS_BLOCKED';
    for(const [option,phase] of [[{worker:true},'worker'],[{},'envelope'],[{fail:name==='claudex-bootstrap'?'bootstrap':'witness'},'helper'],[{fail:'lifecycle'},'recheck']]) {
      const f=fixture({...option,name});
      const result=await f.command(phase==='envelope'?'invalid':`${OP} ${CLAIM}`);
      assert.equal(result.text,`${marker}: ${phase}. Preserve the receipt; do not resend this command.`);
      assert.equal(f.appends.length,0);
      assert.ok(!result.text.includes(OP)&&!result.text.includes('/fixture'));
    }
  }
});
