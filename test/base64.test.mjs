import test from 'node:test';
import assert from 'node:assert/strict';
import { isInlineBase64 } from '../src/base64.mjs';

test('inline base64 retains its lexical padding contract without overflowing on large valid attachments', () => {
  const prior = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const examples = ['', 'A', 'AA', 'AAA', 'AAAA', 'AA==', 'AAA=', 'AAAA====', '=AAA', 'A=AA',
    'AA=A', 'AAA\n', 'AAAA\n', 'AA-=', 'AA_=', 'AA$=', '====', 'B/==', 'AAB=', 'AA==='];
  for (let size = 1; size < 128; size++) {
    const value = Buffer.alloc(size, size).toString('base64');
    examples.push(value, value.slice(1), value + '=', value + '\n', value.slice(0, -1) + '!');
  }
  for (const value of examples) assert.equal(isInlineBase64(value), value.length > 0 && prior.test(value), JSON.stringify(value));
  for (const value of [null, undefined, 123, {}, []]) assert.equal(isInlineBase64(value), false);
  const large = Buffer.alloc(5 * 1024 * 1024, 71).toString('base64');
  assert.equal(isInlineBase64(large), true);
  assert.equal(isInlineBase64(large.slice(0, -1) + '!'), false);
  assert.equal(isInlineBase64(large + '='), false);
});
