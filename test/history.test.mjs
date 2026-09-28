import test from 'node:test';
import assert from 'node:assert/strict';
import { assertComplete, fingerprint, incrementalFingerprint } from '../src/history.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';
import { encodeClaude, decodeClaude } from '../src/claude.mjs';
import { decodeCodex } from '../src/native-drivers.mjs';

const common = blocks => ({ meta: { id: '00000000-0000-4000-8000-000000000099', cwd: '/tmp', timestamp: '2026-09-24T00:00:00Z' }, messages: [
  { role: 'user', content: blocks }, { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
] });

test('self-contained image bytes survive both projections without external dependencies', () => {
  const source = common([{ type: 'text', text: 'Inspect the image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXcAAAAASUVORK5CYII=' } }]);
  assertComplete(source);
  assert.equal(fingerprint(decodeClaude(encodeClaude(source, source.meta.id).text)), fingerprint(source));
  assert.equal(fingerprint(decodeCodex(encodeCodexProjection(source, source.meta.id)).common), fingerprint(source));
});

test('external assets and incomplete tool pairs fail closed', () => {
  assert.throws(() => assertComplete(common([{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image' } }])), /External image/);
  assert.throws(() => assertComplete(common([{ type: 'artifact', artifact: {} }])), /Artifact/);
  const source = common([]);
  source.messages[1].content.unshift({ type: 'tool_use', id: 'unfinished', tool: { name: 'Bash', command: 'echo ok' } });
  assert.throws(() => assertComplete(source), /Unfinished tool/);
});

test('visible reasoning becomes labeled text, never an unsigned provider thinking block', () => {
  const source = common([{ type: 'text', text: 'Question' }]);
  source.messages[1].content.unshift({ type: 'thinking', text: 'Synthetic visible reasoning.' });
  source.messages.splice(1, 0, { role: 'assistant', content: [{ type: 'thinking', text: '' }] });
  const claude = encodeClaude(source, source.meta.id);
  assert.ok(claude.rows.every(row => !row.message?.content.some(block => block.type === 'thinking')));
  const restored = decodeClaude(claude.text);
  assert.match(restored.messages[1].content[0].text, /^\[Imported reasoning\]/);
  assert.equal(fingerprint(restored), fingerprint(source));
  assert.equal(fingerprint(decodeCodex(encodeCodexProjection(restored, source.meta.id)).common), fingerprint(source));
});

test('append-only fingerprints exactly match every full portable prefix without changing the digest format', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', text: '' }] },
    { role: 'user', timestamp: 'ignored', content: [{ text: '你好 🌙\n\u0000\ud800', type: 'text' }] },
    { content: [{ text: 'Visible reasoning', type: 'thinking' }], role: 'assistant' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', input: { z: [null, true, 0, { b: 2, a: 1 }], a: 'unchanged' }, name: 'Example' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Result' }] },
      { source: { data: 'aGVsbG8=', media_type: 'image/png', type: 'base64' }, type: 'image' }] },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'thinking', text: '' }, { type: 'text', text: 'Complete.' }] },
  ];
  const untouched = structuredClone(messages);
  const growing = incrementalFingerprint();
  assert.equal(growing.digest(), fingerprint({ messages: [] }));
  for (let index = 0; index < messages.length; index++) {
    growing.append([messages[index]]);
    const expected = fingerprint({ messages }, index + 1);
    assert.equal(growing.digest(), expected);
    assert.equal(growing.digest(), expected, 'reading a prefix must not finalize or alter the append state');
  }
  const batched = incrementalFingerprint();
  batched.append(messages.slice(0, 3));
  batched.append([]);
  assert.equal(batched.digest(), fingerprint({ messages }, 3));
  batched.append(messages.slice(3));
  assert.equal(batched.digest(), fingerprint({ messages }));
  assert.deepEqual(messages, untouched);
});
