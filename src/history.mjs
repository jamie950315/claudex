import { createHash } from 'node:crypto';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

// Provider signatures are not portable. Preserve visible reasoning as explicitly
// labeled transcript text instead of emitting an unsigned native thinking block.
export function portableContent(content) {
  return content.flatMap(block => block.type === 'thinking'
    ? block.text ? [{ type: 'text', text: `[Imported reasoning]\n${block.text}` }] : []
    : [block]);
}

export function portableMessages(messages) {
  return messages.map(message => ({ ...message, content: portableContent(message.content) })).filter(message => message.content.length);
}

export function fingerprint(common, length = common.messages.length) {
  // Preserve the exact canonical JSON byte sequence without allocating a
  // second serialization of the entire history (including inline images).
  const digest = createHash('sha256').update('[');
  let separator = '';
  for (const { role, content } of common.messages.slice(0, length)) {
    const portable = portableContent(content);
    if (!portable.length) continue;
    digest.update(separator).update(JSON.stringify(ordered({ role, content: portable })));
    separator = ',';
  }
  return digest.update(']').digest('hex');
}

/** Equivalent to fingerprint over an append-only portable message sequence.
 * Hash only the supplied values at append time; callers must not mutate any
 * prior message while comparing growing prefixes. This holds no source cache
 * and does not replace a final independent full-history fingerprint.
 */
export function incrementalFingerprint() {
  const digest = createHash('sha256').update('[');
  let count = 0;
  return {
    append(messages) {
      for (const { role, content } of portableMessages(messages)) {
        if (count++) digest.update(',');
        digest.update(JSON.stringify(ordered({ role, content })));
      }
    },
    digest() { return digest.copy().update(']').digest('hex'); },
  };
}

export function assertComplete(common) {
  if (!common?.meta?.cwd || !Array.isArray(common.messages) || !common.messages.length) throw new Error('Empty or invalid conversation.');
  const last = common.messages.at(-1);
  if (last.role !== 'assistant' || !last.content.some(block => block.type === 'text')) throw new Error('Wait for a complete assistant turn.');
  const pending = new Set();
  for (const message of common.messages) {
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Unsupported message role.');
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (pending.has(block.id)) throw new Error('Duplicate open tool call identifier.');
        pending.add(block.id);
      }
      if (block.type === 'tool_result') {
        if (!pending.delete(block.tool_use_id ?? block.id)) throw new Error('Unpaired tool result; handoff paused.');
      }
      if (block.type === 'image' && (block.source?.type !== 'base64' || !block.source.data)) throw new Error('External image references require verified asset ownership; handoff paused.');
      if (block.type === 'artifact') throw new Error('Artifact handoffs require verified asset ownership; handoff paused.');
    }
  }
  if (pending.size) throw new Error('Unfinished tool call; handoff paused.');
}
