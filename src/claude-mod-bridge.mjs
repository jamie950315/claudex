import { join } from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { privateDir, privateJSON, privateRead, writeReceipt, exclusiveAction } from './claude-mod-storage.mjs';
import { validateRequest, validateParams, sameContext, insist, ModError, identity, context, record } from './claude-mod-protocol.mjs';
import { createWakeOutbox } from './claude-mod-wake-outbox.mjs';
import { inspectSelfInbox, submitSelfInbox } from './claude-mod-self-inbox.mjs';
const TTL = 10 * 60 * 1000;
const JOURNAL_LIMIT = 2048;
const RPC_TIMEOUT = 12000;
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function nativeRpc(envelope) {
  // Reuse the existing authenticated Unix-socket protocol; no new listener.
  const { callCollaboration } = await import('./collaboration-transport.mjs');
  try { return await callCollaboration(envelope); }
  catch (error) {
    if (envelope.method === 'artifact_read' && error.code === 'CLAUDEX_ARTIFACT_REFUSED')
      throw new ModError(error.code, 'Artifact read refused. Select a declared, stable UTF-8 file within the task directory grants and the 64 KiB size limit.');
    throw error;
  }
}
function publicReceipt(receipt) {
  const resultBytes = Buffer.byteLength(JSON.stringify(receipt.result ?? null));
  return { id: receipt.id, state: receipt.state, method: receipt.method, params: receipt.params,
    context: receipt.context, preparedAt: receipt.preparedAt, expiresAt: receipt.expiresAt,
    ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(Object.hasOwn(receipt, 'result') ? { result: resultBytes <= 256 * 1024 ? receipt.result : null,
      resultStoredOnly: resultBytes > 256 * 1024 } : {}),
    automaticReplay: false };
}
const fingerprintOf = (method, params) => createHash('sha256').update(JSON.stringify(canonical({ method, params }))).digest('hex');
function assertReceipt(receipt, id) {
  insist(record(receipt) && receipt.version === 1 && receipt.id === id
    && ['prepared', 'dispatching', 'completed', 'uncertain'].includes(receipt.state)
    && record(receipt.context) && record(receipt.params), 'INVALID_RECEIPT', 'Preserve the malformed action receipt for inspection.');
  const ctx = context(receipt.context);
  insist(sameContext(ctx, receipt.context) && Number.isSafeInteger(receipt.preparedAt)
    && receipt.expiresAt === receipt.preparedAt + TTL, 'INVALID_RECEIPT');
  const params = { ...receipt.params };
  if (receipt.method !== 'models') {
    insist(params.requestId === `mod:${id}`, 'INVALID_RECEIPT'); delete params.requestId;
  }
  const normalized = validateParams(receipt.method, params, true);
  insist(receipt.fingerprint === fingerprintOf(receipt.method, normalized), 'INVALID_RECEIPT', 'Action payload or identity changed. Preserve the receipt for inspection.');
  return receipt;
}
/** Readiness is observed independently from native version acceptance.
 * Every action is tied to an exact session + cwd and to the configured state root. */
export function createModBridge({ root, rpc = nativeRpc, now = Date.now,
  worker = process.env.CLAUDEX_COLLABORATION_WORKER === '1', allowNativeWake = false, allowSelfWake = false,
  inspectInbox = inspectSelfInbox, submitInbox = submitSelfInbox } = {}) {
  const collaborationRoot = join(root ?? '', 'collaboration');
  const journalRoot = join(root ?? '', 'mod-companion');
  const pathFor = id => join(journalRoot, `${identity(id, true)}.json`);
  async function stopState() {
    const value = await privateJSON(join(root, 'app-stop.json'), { optional: true, maxBytes: 4096 });
    if (value !== null) insist(value.version === 1 && typeof value.stopped === 'boolean' && (value.resuming === undefined || typeof value.resuming === 'boolean'), 'INVALID_STOP_STATE', 'Application stop state requires inspection.');
    return value?.stopped === true || value?.resuming === true;
  }
  async function active() {
    insist(!await stopState(), 'APP_STOPPED', 'Claudex is stopped or resuming; inspect its normal application lifecycle.');
  }
  async function requestRpc(method, params) {
    await privateDir(collaborationRoot);
    const raw = await privateRead(join(collaborationRoot, 'controller-key'), { maxBytes: 65 });
    insist(/^[a-f0-9]{64}\n$/.test(raw), 'INVALID_CAPABILITY', 'The controller capability requires inspection.');
    try {
      return await rpc({ root: collaborationRoot, peer: 'claude', token: raw.trim(), method, params,
        timeoutMs: method === 'mod_wake_wait' ? 25000 : RPC_TIMEOUT });
    } catch (error) {
      if (error.code === 'MOD_TARGET_UNAVAILABLE') throw new ModError(error.code, 'The exact recipient metadata is unavailable or changed.');
      throw error;
    }
  }
  async function receipt(id) {
    await privateDir(journalRoot);
    return assertReceipt(await privateJSON(pathFor(id), { maxBytes: 2 * 1024 * 1024 }), id);
  }
  const outbox = createWakeOutbox(root, request => requestRpc('mod_wake_receipt', {
    source: request.context, target: request.target, messageId: request.messageId,
    claimId: request.claimId, status: request.status, reason: request.reason,
    ...(request.route ? { route: request.route } : {}),
  }));
  return async function handle(input) {
    insist(!worker, 'MANAGED_WORKER', 'Managed workers retain their generation-scoped MCP capabilities.');
    const request = validateRequest(input);
    await privateDir(root);
    if (request.op === 'doctor') {
      let socketPresent = false;
      try {
        await privateDir(collaborationRoot);
        const socket = await lstat(join(collaborationRoot, 'rpc.sock'));
        socketPresent = socket.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o777) === 0o600;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { version: 1, root, stopped: await stopState(), socketPresent, nodeVersion: process.version,
        nativeWakeEnabled: allowNativeWake, synchronizationPolicy: 'unchanged',
        compatibility: { documentedModBaseline: '2.1.287', versionLoadGate: false,
          synchronizationAcceptance: 'separate-required-check' },
        note: 'A socket pathname is presence evidence. Refresh task status to verify a broker response. Keep existing hooks and renderer fallbacks.' };
    }
    if (request.op === 'receipt') {
      const saved = await receipt(request.id);
      insist(sameContext(saved.context, request.context), 'CONTEXT_CHANGED', 'Inspect this receipt from its original exact session and directory, or use the local operator workflow.');
      return publicReceipt(saved);
    }
    // Finishing an already claimed dispatch remains possible after an application stop.
    if (request.op === 'wake-next' && allowNativeWake) {
      const recovered = await outbox.recover();
      if (recovered.remaining) return { state: 'receipt-recovery', messages: [] };
    }
    if (request.op !== 'wake-receipt' && !(request.op === 'wake-observe' && request.observation.lifecycle === 'ended')) await active();
    if (request.op === 'wake-observe') return requestRpc('mod_wake_observe', { source: request.context, observation: {
      ...request.observation, nativeWake: allowNativeWake, selfWake: allowSelfWake,
    } });
    if (request.op === 'read') return requestRpc(request.method, request.params);
    if (request.op === 'prepare') {
      await privateDir(collaborationRoot);
      await privateDir(journalRoot, true);
      const normalized = { ...request.params };
      if (request.method === 'start' && (normalized.model === undefined || normalized.effort === undefined)) {
        const defaults = await requestRpc('models', {});
        insist(record(defaults?.defaultModels) && record(defaults?.defaultEfforts)
          && Object.hasOwn(defaults.defaultModels, normalized.provider)
          && Object.hasOwn(defaults.defaultEfforts, normalized.provider), 'INVALID_DEFAULTS', 'Read verified provider defaults before delegation.');
        if (normalized.model === undefined) normalized.model = defaults.defaultModels[normalized.provider];
        if (normalized.effort === undefined) normalized.effort = defaults.defaultEfforts[normalized.provider];
        validateParams('start', normalized, true);
      }
      // A durable intent pointer fences equivalent unknown actions across UI reloads/sessions.
      const fingerprint = fingerprintOf(request.method, normalized);
      const intentPath = join(journalRoot, `intent-${fingerprint}.json`);
      return exclusiveAction(join(journalRoot, `intent-${fingerprint}.lock`), async () => {
        const intent = await privateJSON(intentPath, { optional: true, maxBytes: 4096 });
        if (intent) {
          insist(intent.version === 1 && typeof intent.id === 'string', 'INVALID_RECEIPT');
          const previous = await receipt(intent.id);
          insist(previous.fingerprint === fingerprint, 'INVALID_RECEIPT');
          insist(!['dispatching', 'uncertain'].includes(previous.state), 'UNCERTAIN_ACTION',
            `Equivalent action ${previous.id} has an uncertain dispatch. Preserve its receipt and inspect the broker before further work.`);
          if (previous.state === 'prepared' && previous.expiresAt > now()) {
            insist(sameContext(previous.context, request.context), 'PREVIEW_HELD', 'An equivalent preview belongs to another exact session; wait for its expiry or inspect it locally.');
            return publicReceipt(previous);
          }
        }
        insist((await readdir(journalRoot)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).length < JOURNAL_LIMIT,
          'JOURNAL_FULL', 'Preserve the bounded action journal; perform operator-led retention before adding actions.');
        const id = randomUUID(), preparedAt = now();
        const params = { ...normalized, ...(request.method === 'models' ? {} : { requestId: `mod:${id}` }) };
        const saved = { version: 1, id, fingerprint, method: request.method, params, context: request.context,
          state: 'prepared', preparedAt, expiresAt: preparedAt + TTL };
        await writeReceipt(pathFor(id), saved, { exclusive: true });
        await writeReceipt(intentPath, { version: 1, id }, { exclusive: intent === null });
        return publicReceipt(saved);
      });
    }
    if (request.op === 'commit') {
      await privateDir(journalRoot);
      return exclusiveAction(join(journalRoot, `${request.id}.lock`), async () => {
        const saved = await receipt(request.id);
        insist(sameContext(saved.context, request.context), 'CONTEXT_CHANGED', 'Session or directory changed after preview. Prepare a new action in the intended session.');
        // Completed/unknown dispatches return evidence; they never execute again.
        if (saved.state !== 'prepared') return publicReceipt(saved);
        insist(now() < saved.expiresAt, 'PREVIEW_EXPIRED', 'The ten-minute preview expired. Review a fresh action.');
        await active();
        saved.state = 'dispatching'; saved.dispatchedAt = now();
        await writeReceipt(pathFor(saved.id), saved);
        try {
          saved.result = await requestRpc(saved.method, saved.params);
          saved.state = 'completed';
        } catch {
          saved.state = 'uncertain';
          saved.error = { code: 'DISPATCH_UNCERTAIN', message: 'Inspect the broker using the saved requestId/task/message identity. Automatic replay is disabled.' };
        }
        saved.finishedAt = now();
        await writeReceipt(pathFor(saved.id), saved);
        return publicReceipt(saved);
      });
    }
    insist(allowNativeWake, 'NATIVE_WAKE_DISABLED', 'Enable native receipt only after the documented local acceptance checks.');
    if (request.op.startsWith('wake-self-') || request.route === 'mod-self')
      insist(allowSelfWake && request.route === 'mod-self' && sameContext(request.context, request.target), 'SELF_WAKE_DISABLED', 'Enable own-inbox delivery explicitly and use the current exact session.');
    const wakeParams = { source: request.context, target: request.target, messageId: request.messageId,
      ...(request.claimId ? { claimId: request.claimId } : {}), ...(request.route ? { route: request.route } : {}) };
    if (request.op === 'wake-next') return requestRpc('mod_wake_wait', { source: request.context, excludeIds: request.excludeIds,
      ...(request.observation ? { observation: { ...request.observation, nativeWake: allowNativeWake, selfWake: allowSelfWake } } : {}),
      ...(allowSelfWake ? { self: true } : {}) });
    if (request.op === 'wake-peek') {
      const result = await requestRpc('mod_wake_wait', { source: request.context, timeoutMs: 0, ...(allowSelfWake ? { self: true } : {}) });
      return { target: request.target, messages: result.messages.filter(m => sameContext(m.target, request.target)) };
    }
    if (request.op === 'wake-claim') {
      if (request.route === 'mod-self') await inspectInbox();
      return requestRpc('mod_wake_claim', wakeParams);
    }
    if (request.op === 'wake-check') {
      const result = await requestRpc('mod_wake_check', wakeParams);
      await active(); return result;
    }
    if (request.op === 'wake-self-receive') {
      const result = await requestRpc('mod_wake_receive', wakeParams);
      await active(); return result;
    }
    if (request.op === 'wake-self-send') {
      // Only identifiers cross the native inbox. The receiving Mod retrieves the
      // original quoted peer context from the exact durable claim before next(e).
      const payload = `CLAUDEX_SELF_INBOX_V1\n${JSON.stringify({ messageId: request.messageId, claimId: request.claimId, target: request.target })}`;
      const directory = join(root, 'mod-self-dispatch');
      await privateDir(directory, true);
      return exclusiveAction(join(directory, `${request.claimId}.lock`), async () => {
        const path = join(directory, `${request.claimId}.json`);
        const identity = { context: request.context, target: request.target, messageId: request.messageId, claimId: request.claimId, route: request.route };
        const saved = await privateJSON(path, { optional: true });
        if (saved) {
          insist(saved.version === 1 && JSON.stringify(saved.identity) === JSON.stringify(identity), 'INVALID_RECEIPT');
          return saved.outcome ?? { state: 'uncertain', reason: 'dispatch-recorded', automaticReplay: false };
        }
        insist((await readdir(directory)).filter(name => name.endsWith('.json')).length < JOURNAL_LIMIT, 'JOURNAL_FULL');
        await writeReceipt(path, { version: 1, identity }, { exclusive: true });
        const outcome = await submitInbox(payload, { beforeWrite: async () => {
          const guard = await requestRpc('mod_wake_check', wakeParams);
          insist(guard?.ready === true, 'INVALID_RECEIPT', 'Self dispatch readiness was not confirmed.');
          await active();
          return true;
        } });
        await writeReceipt(path, { version: 1, identity, outcome });
        return outcome;
      });
    }
    if (request.op === 'wake-receipt') return outbox.record(request);
    throw new ModError('UNSUPPORTED_OPERATION', 'Unsupported operation.');
  };
}
