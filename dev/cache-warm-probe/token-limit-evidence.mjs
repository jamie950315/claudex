// Content-free accounting: stream and final assistant frames may describe the
// same response. Deduplicate by native response ID; never store generated text.
const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
export function createTokenLimitEvidence() {
  const responses = new Map(), retries = [], errors = [];
  let currentId;
  function accept(message, turn) {
    if (!message?.id || !message.model || message.model.startsWith('<')) return;
    const previous = responses.get(message.id) ?? { turn, model: message.model, usage: {} };
    const usage = { ...previous.usage };
    // Block-level assistant frames can arrive with provisional usage. A later
    // provisional frame must not overwrite an already observed terminal delta.
    if (!previous.stopReason || message.stop_reason) for (const key of fields)
      if (Number.isSafeInteger(message.usage?.[key]) && message.usage[key] >= 0) usage[key] = message.usage[key];
    responses.set(message.id, { ...previous, stopReason: message.stop_reason ?? previous.stopReason ?? null, usage });
    currentId = message.id;
  }
  return {
    observe(event, turn) {
      if (event.parent_tool_use_id) return;
      if (event.type === 'stream_event') {
        const e = event.event;
        if (e.type === 'message_start') accept(e.message, turn);
        else if (e.type === 'message_delta' && currentId && responses.has(currentId)) {
          const previous = responses.get(currentId);
          accept({ id: currentId, model: previous.model, usage: e.usage, stop_reason: e.delta?.stop_reason }, turn);
        }
      } else if (event.type === 'assistant') {
        if (event.isApiErrorMessage || event.error) errors.push({ turn, error: event.error ?? event.apiError ?? 'native-api-error' });
        else accept(event.message, turn);
      } else if (event.type === 'system' && event.subtype === 'api_retry') {
        retries.push({ turn, attempt: event.attempt ?? null, maxRetries: event.max_retries ?? null,
          status: event.error_status ?? null });
      }
    },
    summary() {
      const rows = [...responses.values()];
      const countsComplete = rows.length > 0 && rows.every(row => fields.every(key => Number.isSafeInteger(row.usage[key])));
      return { responseCount: rows.length, countsComplete, responses: rows, retries, errors,
        totals: countsComplete ? Object.fromEntries(fields.map(key => [key, rows.reduce((sum, row) => sum + row.usage[key], 0)])) : null };
    },
  };
}
