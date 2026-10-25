const syncUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const syncText = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const syncPath = value => syncText(value) && value.startsWith('/') && !value.startsWith('//')
  && !value.split('/').some(part => part === '.' || part === '..');

/** Dispatches an authenticated local command, never an ordinary model prompt.
 * The coordinator verifies native persistence; a send receipt is not an ACK.
 */
export function createClaudeLocalSyncRuntime({ readManifest, native, root, registryRoot,
  hasDraft = () => true, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, intervalMs = 2000, onStatus = () => {} } = {}) {
  let running = false, timer, inFlight = false, generation = 0, lastStatus;
  const attempted = new Map();
  const report = code => { if (lastStatus !== code) { lastStatus = code; try { onStatus(code); } catch {} } };
  const decode = (result, limit) => {
    if (!result || typeof result.contents !== 'string' || result.isTail || result.contents.length > limit)
      throw new Error('Local synchronization metadata is unavailable or truncated');
    return JSON.parse(result.contents);
  };
  function valid(entry) {
    if (!syncPath(root) || !syncPath(registryRoot) || !syncUuid(entry?.opId)
      || !syncUuid(entry.conversationId) || !syncUuid(entry.cliSessionId) || !syncUuid(entry.inputUuid)
      || !/^local_[a-f0-9-]{36}$/i.test(entry.localSessionId ?? '') || !syncUuid(entry.localSessionId.slice(6))
      || !syncPath(entry.cwd) || !syncText(entry.title) || !syncPath(entry.registryPath)
      || !entry.registryPath.startsWith(`${registryRoot}/`)
      || !entry.registryPath.endsWith(`/${entry.localSessionId}.json`)
      || entry.command !== 'claudex-sync' || entry.args !== entry.opId
      || !Number.isSafeInteger(entry.expiresAt) || !Array.isArray(entry.images) || entry.images.length > 64)
      throw new Error('Local synchronization identity is invalid');
    entry.images.forEach((image, index) => {
      if (image?.path !== `${root}/local-sync/${entry.opId}/image-${index}.json`
        || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType))
        throw new Error('Local synchronization image is invalid');
    });
  }
  async function manifest() {
    const value = decode(await readManifest(), 256 * 1024);
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 64)
      throw new Error('Local synchronization manifest is invalid');
    const seen = new Set();
    for (const entry of value.entries) {
      valid(entry);
      if (seen.has(entry.opId)) throw new Error('Local synchronization operation is ambiguous');
      seen.add(entry.opId);
    }
    return value;
  }
  function idle(session, entry) {
    if (!session || session.sessionId !== entry.localSessionId || session.cwd !== entry.cwd || session.title !== entry.title)
      return false;
    if (['isArchived', 'isRunning', 'turnRunning'].some(key => session[key] !== false)
      || !Number.isSafeInteger(session.lastActivityAt)) return false;
    if (['cliBootPending', 'starting', 'heldInput', 'hasBackgroundActivity', 'hasBackgroundWork',
      'remoteTarget', 'pendingCwd', 'pendingCwdTrustPrompt', 'remoteControlConnecting', 'scheduledTaskId',
      'agentDispatched', 'lanyard', 'pendingRefusalFallbackPrompt', 'pendingAutoModeServerFallbackPrompt',
      'pendingLanyardConsent', 'pendingViolinBowPrompt', 'pendingRewind', 'isStopping'].some(key => session[key])) return false;
    for (const key of ['pendingToolPermissions', 'loops', 'spawningTaskIds'])
      if (session[key] !== undefined && (!Array.isArray(session[key]) || session[key].length)) return false;
    return true;
  }
  async function inspect(entry) {
    const cut = entry.registryPath.lastIndexOf('/');
    const mapped = decode(await native.readFileAtCwd(entry.registryPath.slice(0, cut), entry.registryPath.slice(cut + 1)), 8 * 1024 * 1024);
    if (mapped.sessionId !== entry.localSessionId || mapped.cliSessionId !== entry.cliSessionId
      || mapped.cwd !== entry.cwd || mapped.title !== entry.title || mapped.isArchived !== false) return null;
    const session = await native.getSession(entry.localSessionId);
    if (!idle(session, entry) || session.lastActivityAt !== mapped.lastActivityAt || hasDraft(entry.localSessionId)) return null;
    const busy = await native.getBusyShellPtyKeys(entry.localSessionId, false);
    if (busy?.probed !== true || !Array.isArray(busy.busy) || busy.busy.length
      || !Array.isArray(busy.unknown) || busy.unknown.length) return null;
    // A cold catalogue does not run Mod registration. Never submit an unknown
    // slash command: native would otherwise treat it as an ordinary prompt.
    const commands = await native.getSupportedCommands({ sessionId: entry.localSessionId });
    if (!Array.isArray(commands) || commands.filter(command => command?.name === entry.command).length !== 1)
      return null;
    const current = await native.getSession(entry.localSessionId);
    return idle(current, entry) && current.lastActivityAt === session.lastActivityAt ? current : null;
  }
  function toolResult(value) {
    if (value?.isError) throw new Error('Local synchronization claim was refused');
    if (value?.structuredContent) return value.structuredContent;
    const texts = value?.content?.filter(item => item.type === 'text');
    if (texts?.length !== 1 || typeof texts[0].text !== 'string' || texts[0].text.length > 32_768)
      throw new Error('Local synchronization receipt is invalid');
    return JSON.parse(texts[0].text);
  }
  const identities = entry => ({ opId: entry.opId, localSessionId: entry.localSessionId,
    cliSessionId: entry.cliSessionId, cwd: entry.cwd });
  const call = async (entry, name, args) => toolResult(await native.mcpCallTool(entry.localSessionId,
    'claudex-desktop-wake', name, args));
  async function imagesFor(entry) {
    const images = [];
    for (const image of entry.images) {
      const cut = image.path.lastIndexOf('/');
      const value = decode(await native.readFileAtCwd(image.path.slice(0, cut), image.path.slice(cut + 1)), 4 * 1024 * 1024);
      if (value?.mimeType !== image.mimeType || typeof value.base64 !== 'string' || !value.base64
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))
        throw new Error('Local synchronization image data is invalid');
      images.push({ mimeType: value.mimeType, base64: value.base64 });
    }
    return images;
  }
  async function authorized(entry, ticket, activity) {
    if (!running || ticket !== generation || entry.expiresAt <= now()) return false;
    const current = await inspect(entry);
    if (!current || current.lastActivityAt !== activity) return false;
    const latest = await manifest();
    return running && ticket === generation && entry.expiresAt > now() && !hasDraft(entry.localSessionId)
      && latest.entries.some(candidate => JSON.stringify(candidate) === JSON.stringify(entry));
  }
  async function poll() {
    if (!running || inFlight) return;
    inFlight = true; const ticket = generation;
    try {
      if (['readFileAtCwd', 'getSession', 'getBusyShellPtyKeys', 'getSupportedCommands', 'mcpCallTool', 'sendMessage'].some(name => typeof native?.[name] !== 'function')) {
        report('native-api-unavailable'); return;
      }
      const value = await manifest();
      for (const [opId, expiresAt] of attempted) if (expiresAt <= now()) attempted.delete(opId);
      for (const entry of value.entries) {
        if (!running || ticket !== generation) break;
        if (entry.expiresAt <= now() || attempted.has(entry.opId)) continue;
        let before, images;
        try {
          before = await inspect(entry);
          if (!before) { report('waiting-native-idle'); continue; }
          images = await imagesFor(entry);
          if (!await authorized(entry, ticket, before.lastActivityAt)) continue;
        } catch { report('waiting-native-metadata'); continue; }
        attempted.set(entry.opId, entry.expiresAt);
        const claim = await call(entry, 'claudex_local_sync_claim', identities(entry));
        if (claim?.ready !== true) { report('claim-not-ready'); continue; }
        if (!syncUuid(claim.claimId) || Object.entries(identities(entry)).some(([key, v]) => claim[key] !== v)
          || claim.inputUuid !== entry.inputUuid || claim.command !== entry.command || claim.args !== entry.args
          || JSON.stringify(claim.images) !== JSON.stringify(entry.images)) throw new Error('Local synchronization claim changed');
        let outcome = 'rejected', detail = 'authority-changed';
        let permitted = false;
        try { permitted = await authorized(entry, ticket, before.lastActivityAt); }
        catch { report('authority-unavailable'); }
        if (permitted) {
          // From this point an exception cannot prove that native input was not written.
          outcome = 'unknown'; detail = 'native-send-unknown';
          try {
            await native.sendMessage(entry.localSessionId, `/claudex-sync ${entry.opId} ${claim.claimId}`,
              images.length ? images : undefined, undefined, undefined, undefined, undefined, entry.inputUuid);
            outcome = 'submitted'; detail = 'native-send-returned'; report('submitted-awaiting-native-proof');
          } catch { report('native-send-unknown'); }
        }
        await call(entry, 'claudex_local_sync_receipt', { ...identities(entry), claimId: claim.claimId, outcome, detail });
        break;
      }
    } catch { report('local-sync-unavailable'); }
    finally { inFlight = false; if (running) timer = setTimer(poll, intervalMs); }
  }
  return {
    start() { if (!running) { running = true; generation++; report('started'); void poll(); } },
    stop() { running = false; generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; },
    poll,
  };
}
