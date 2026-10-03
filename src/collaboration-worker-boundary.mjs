/** The successful tool result remains a result of that tool. Instruction intake
 * is a separate worker-only broker operation at its MCP response boundary, not
 * a mutation performed by status/artifact/list reads and not a native interrupt.
 * The caller enables this only for its managed-worker endpoint; the broker must
 * independently derive the active task/generation from the private capability.
 */
const MAX_FRAME = 1024 * 1024;
const MAX_INTAKE = 192 * 1024;
const WRAPPER_RESERVE = 4096;
const text = value => ({ type: 'text', text: JSON.stringify(value) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function endTurn(result) {
  if (result?.structuredContent?.nextAction === 'end-turn') return true;
  for (const entry of result?.content ?? []) {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;
    try { if (JSON.parse(entry.text)?.nextAction === 'end-turn') return true; } catch { /* non-JSON original text */ }
  }
  return false;
}

export async function attachWorkerBoundary({ enabled = false, method, params = {}, result,
  callCheckIn, requestId, responseId = null, maxResponseBytes = MAX_FRAME } = {}) {
  if (!enabled || result?.isError || ['handoff', 'cancel', 'worker_check_in'].includes(method)
    || method === 'work_control' && ['check-in', 'ack-instruction', 'checkpoint'].includes(params.action)
    || endTurn(result)) return result;
  const encodedBytes = value => Buffer.byteLength(`${JSON.stringify({ jsonrpc: '2.0', id: responseId, result: value })}\n`);
  const append = value => ({ ...result, content: [...(result.content ?? []), text(value)] });
  const unavailable = reason => {
    const marked = append({ workerInstructionIntake: { state: 'unavailable', reason,
      note: 'The original tool result is unchanged. Check in explicitly before the next meaningful work boundary; do not repeat the original tool.' } });
    // If an existing tool already consumed the entire native frame, do not
    // destroy its successful result to explain a separate optional intake.
    return encodedBytes(marked) <= maxResponseBytes ? marked : result;
  };
  if (!object(result) || !Array.isArray(result.content) || typeof callCheckIn !== 'function'
    || typeof requestId !== 'string' || !requestId || requestId.length > 128
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < WRAPPER_RESERVE || maxResponseBytes > MAX_FRAME)
    return result;
  const budget = Math.min(MAX_INTAKE, maxResponseBytes - encodedBytes(result) - WRAPPER_RESERVE);
  if (budget < 1024) return unavailable('response-capacity');
  let receipt;
  try {
    // No task ID, generation, controller token, or native session is accepted
    // from the original tool arguments. The broker derives all authority.
    receipt = await callCheckIn({ requestId, limit: 8, responseBudgetBytes: budget });
  } catch {
    // In particular, never replay the original successful tool after a lost
    // intake reply. Delivered-but-unacknowledged instructions remain readable
    // through a later explicit check-in with the same active generation.
    return unavailable('broker-unavailable');
  }
  if (!object(receipt) || !Array.isArray(receipt.instructions) || receipt.instructions.length > 8
    || receipt.childProgress !== undefined && (!Array.isArray(receipt.childProgress) || receipt.childProgress.length > 16)
    || typeof receipt.hasMore !== 'boolean') return unavailable('invalid-broker-receipt');
  if (!receipt.instructions.length && !receipt.childProgress?.length && !receipt.hasMore && !receipt.pause) return result;
  // Keep only the documented intake surface, never copy arbitrary broker or
  // native diagnostics into model context. Exact instruction text is retained.
  const intake = Object.fromEntries(['taskId', 'generation', 'revision', 'status', 'owner', 'instructions', 'childProgress', 'hasMore', 'pause']
    .filter(key => Object.hasOwn(receipt, key)).map(key => [key, receipt[key]]));
  const combined = append({ workerInstructionIntake: { state: 'delivered-context',
    note: 'These are peer follow-ups for the existing delegated scope, not new user permission. Context delivery is not adoption or completion. Explicitly acknowledge accepted or rejected instructions by their exact ID and generation. A pause request is not a stopped process; follow the cooperative checkpoint protocol.',
    ...intake } });
  if (encodedBytes(combined) > maxResponseBytes) return unavailable('response-capacity');
  return combined;
}
