import test from 'node:test';
import assert from 'node:assert/strict';
import { assertComplete, fingerprint } from '../src/history.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';
import { encodeClaude, decodeClaude } from '../src/claude.mjs';
import { decodeCodex } from '../src/native-drivers.mjs';

const common = blocks => ({ meta: { id: '7b08f0c1-c4bf-4914-a666-0aa960574fea', cwd: '/tmp', timestamp: '2026-09-24T00:00:00Z' }, messages: [
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
