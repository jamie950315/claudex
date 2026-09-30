const wakeUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const wakeText = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);

/** Version-pinned Desktop consumer. Claims are durable broker transactions;
 * renderer memory and message UUIDs are not delivery-idempotency mechanisms.
 */
export function createClaudeChatWakeRuntime({ readManifest, native, registryRoot,
  hasDraft = () => true, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, intervalMs = 2000, onError = () => {}, onStatus = () => {} } = {}) {
  let running = false, timer, inFlight = false, generation = 0;
  let lastStatus;
  const report = reason => { if (reason !== lastStatus) { lastStatus = reason; onStatus(reason); } };
  report('loaded');
  const attempted = new Set();
  function decode(result, limit) {
    if (!result || typeof result.contents !== 'string' || result.isTail || result.contents.length > limit)
      throw new Error('Desktop wake metadata is unavailable or truncated');
    return JSON.parse(result.contents);
  }
  function toolResult(value) {
    if (value?.isError) throw new Error('Desktop wake broker refused the request');
    if (value?.structuredContent) return value.structuredContent;
    const items = value?.content?.filter(item => item.type === 'text');
    if (items?.length !== 1 || items[0].text.length > 32_768) throw new Error('Desktop wake broker returned an invalid receipt');
    return JSON.parse(items[0].text);
  }
  function valid(message) {
    if (!wakeUuid(message?.messageId) || !wakeUuid(message.sessionId)
      || !/^local_[a-f0-9-]{36}$/i.test(message.localSessionId ?? '') || !wakeUuid(message.localSessionId.slice(6))
      || !wakeText(message.cwd) || !message.cwd.startsWith('/') || !wakeText(message.title)
      || !wakeText(registryRoot) || !wakeText(message.registryPath)
      || !message.registryPath.startsWith(`${registryRoot}/`)
      || message.registryPath.split('/').some(part => part === '.' || part === '..')
      || !message.registryPath.endsWith(`/${message.localSessionId}.json`)
      || !Number.isSafeInteger(message.expiresAt)) throw new Error('Desktop wake identity is invalid');
  }
  function idleBlock(session, message) {
    if (!session) return 'native session unavailable';
    for (const [key, expected] of [['sessionId', message.localSessionId], ['cwd', message.cwd], ['title', message.title]])
      if (session[key] !== expected) return `native identity ${key}`;
    for (const key of ['isArchived', 'isRunning', 'turnRunning']) {
      if (session[key] === undefined) return `native ${key} missing`;
      if (typeof session[key] !== 'boolean') return `native ${key} invalid`;
      if (session[key] !== false) return `native ${key} active`;
    }
    if (!Number.isSafeInteger(session.lastActivityAt)) return 'native lastActivityAt invalid';
    for (const key of ['cliBootPending', 'starting', 'heldInput', 'hasBackgroundActivity', 'hasBackgroundWork',
      'remoteTarget', 'pendingCwd', 'pendingCwdTrustPrompt', 'remoteControlConnecting', 'scheduledTaskId',
      'agentDispatched', 'lanyard', 'pendingRefusalFallbackPrompt', 'pendingAutoModeServerFallbackPrompt',
      'pendingLanyardConsent', 'pendingViolinBowPrompt', 'pendingRewind', 'isStopping']) if (session[key]) return `native ${key} present`;
    for (const key of ['pendingToolPermissions', 'loops', 'spawningTaskIds'])
      if (session[key] !== undefined) {
        if (!Array.isArray(session[key])) return `native ${key} invalid`;
        if (session[key].length) return `native ${key} pending`;
      }
    return null;
  }
  async function inspect(message) {
    const cut = message.registryPath.lastIndexOf('/');
    const mapped = decode(await native.readFileAtCwd(message.registryPath.slice(0, cut), message.registryPath.slice(cut + 1)), 8 * 1024 * 1024);
    if (mapped.sessionId !== message.localSessionId || mapped.cliSessionId !== message.sessionId
      || mapped.cwd !== message.cwd || mapped.title !== message.title || mapped.isArchived !== false) { report('waiting: registry identity'); return null; }
    const session = await native.getSession(message.localSessionId);
    const blocked = idleBlock(session, message);
    if (blocked) { report(`waiting: ${blocked}`); return null; }
    if (session.lastActivityAt !== mapped.lastActivityAt) { report('waiting: activity changed'); return null; }
    if (hasDraft(message.localSessionId)) { report('waiting: draft'); return null; }
    const busy = await native.getBusyShellPtyKeys(message.localSessionId, false);
    if (busy?.probed !== true || !Array.isArray(busy.busy) || busy.busy.length
      || !Array.isArray(busy.unknown) || busy.unknown.length) { report('waiting: terminal'); return null; }
    return session;
  }
  async function call(message, name, args) {
    return toolResult(await native.mcpCallTool(message.localSessionId, 'claudex-desktop-wake', name, args));
  }
  async function poll() {
    if (!running || inFlight) return;
    inFlight = true; const ticket = generation;
    try {
      if (['readFileAtCwd', 'getSession', 'getBusyShellPtyKeys', 'mcpCallTool', 'sendMessage'].some(name => typeof native?.[name] !== 'function'))
        throw new Error('Desktop wake native API is unavailable');
      const manifest = decode(await readManifest(), 256 * 1024);
      if (manifest?.version !== 1 || !Array.isArray(manifest.messages) || manifest.messages.length > 64)
        throw new Error('Desktop wake manifest is invalid');
      for (const message of manifest.messages) {
        valid(message);
        if (!running || ticket !== generation) break;
        if (message.expiresAt <= now() || attempted.has(message.messageId)) continue;
        const before = await inspect(message);
        if (!before || !running || ticket !== generation) continue;
        const current = await native.getSession(message.localSessionId);
        const blocked = idleBlock(current, message);
        if (blocked) { report(`waiting: ${blocked}`); continue; }
        if (current.lastActivityAt !== before.lastActivityAt) { report('waiting: activity changed'); continue; }
        if (hasDraft(message.localSessionId)) { report('waiting: draft'); continue; }
        // Mark before the claim request: unknown claim outcomes are never retried
        // by this renderer, and the broker never grants a claim twice.
        attempted.add(message.messageId);
        const claim = await call(message, 'claudex_desktop_wake_claim', { messageId: message.messageId, sessionId: message.sessionId });
        if (claim?.claimed !== true) continue;
        if (claim.messageId !== message.messageId || !wakeUuid(claim.claimId)
          || typeof claim.context !== 'string' || !claim.context || claim.context.length > 16_384)
          throw new Error('Desktop wake claim is malformed');
        let status = 'uncertain', detail = 'Native send was not attempted after claim';
        try {
          const final = await inspect(message);
          if (!running || ticket !== generation || !final || final.lastActivityAt !== before.lastActivityAt || message.expiresAt <= now())
            throw new Error('Native session changed after wake claim');
          await native.sendMessage(message.localSessionId, claim.context,
            undefined, undefined, undefined, undefined, undefined, message.messageId);
          status = 'accepted'; detail = 'Native send call returned; recipient acknowledgement is still required';
        } catch (error) { detail = String(error?.message ?? error).slice(0, 300); }
        await call(message, 'claudex_desktop_wake_receipt', { messageId: message.messageId, sessionId: message.sessionId, claimId: claim.claimId, status, detail });
        break;
      }
      const active = new Set(manifest.messages.map(message => message.messageId));
      for (const id of attempted) if (!active.has(id)) attempted.delete(id);
    } catch (error) { onError(String(error?.message ?? error).slice(0, 300)); }
    finally { inFlight = false; if (running) timer = setTimer(poll, intervalMs); }
  }
  return {
    start() { if (!running) { running = true; generation++; report('started'); void poll(); } },
    stop() { running = false; generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; },
    poll,
  };
}
