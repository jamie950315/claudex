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

/** Native resume-picker adoption. No deep links, CLI opener or model prompts.
 * An attached user-config stdio client journals each native action beforehand.
 */
export function createClaudeLocalAdoptionRuntime({ readManifest, native, getClient,
  hasDraft = () => true, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, intervalMs = 2000, onStatus = () => {},
  digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('') } = {}) {
  let running = false, generation = 0, inFlight = false, timer, lastStatus;
  const attempted = new Set();
  const report = code => { if (lastStatus !== code) { lastStatus = code; try { onStatus(code); } catch {} } };
  const decode = (result, limit) => {
    if (!result || typeof result.contents !== 'string' || result.isTail || result.contents.length > limit)
      throw new Error('Native adoption metadata unavailable');
    return JSON.parse(result.contents);
  };
  async function manifest() {
    const value = decode(await readManifest(), 256 * 1024);
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1)
      throw new Error('Native adoption manifest invalid');
    for (const e of value.entries) {
      if (!['resume', 'activate'].includes(e.action) || !syncUuid(e.opId) || !syncUuid(e.sourceOperationId)
        || !syncUuid(e.conversationId) || !syncUuid(e.cliSessionId) || !syncUuid(e.seedUuid)
        || !syncPath(e.cwd) || !/^[a-f0-9]{64}$/.test(e.seedContentDigest ?? '') || !Number.isSafeInteger(e.expiresAt))
        throw new Error('Native adoption identity invalid');
      if (e.action === 'activate' && (!syncUuid(e.localSessionId?.slice(6)) || !e.localSessionId.startsWith('local_')
        || !syncText(e.title) || !Number.isSafeInteger(e.lastActivityAt) || !syncPath(e.registryPath)
        || !e.registryPath.endsWith(`/${e.localSessionId}.json`))) throw new Error('Native activation identity invalid');
    }
    return value.entries;
  }
  function client() {
    const c = getClient?.('claudex-desktop-wake'), t = c?.transport;
    if (!t || t._closed !== false || t.pid !== null || t.stderr !== null
      || typeof t._port?.postMessage !== 'function' || typeof t._port?.close !== 'function'
      || typeof c.callTool !== 'function' || c.getServerVersion?.()?.name !== 'claudex'
      || !c.getServerCapabilities?.()?.tools) throw new Error('Attached Claudex stdio client unavailable');
    return c;
  }
  async function call(name, args) {
    const result = await client().callTool({ name, arguments: args });
    if (result?.isError) throw new Error('Native adoption authority refused');
    if (result?.structuredContent) return result.structuredContent;
    const texts = result?.content?.filter(x => x.type === 'text');
    if (texts?.length !== 1 || typeof texts[0].text !== 'string' || texts[0].text.length > 32768)
      throw new Error('Native adoption receipt unavailable');
    return JSON.parse(texts[0].text);
  }
  async function current(e, ticket) {
    return running && ticket === generation && e.expiresAt > now() && !hasDraft(e.localSessionId)
      && (await manifest()).some(v => JSON.stringify(v) === JSON.stringify(e))
      && running && ticket === generation && !hasDraft(e.localSessionId);
  }
  async function candidate(e) {
    const rows = await native.listResumableCliSessions(1000);
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Native resume inventory invalid');
    const matches = [];
    for (const row of rows.filter(r => r?.cwd === e.cwd && syncUuid(r.handle)
      && r.liveness === 'not_running' && !r.folderMissing && !r.bridgeSessionId)) {
      const transcript = await native.readCliTranscript(row.handle, 0, 5000);
      if (!Array.isArray(transcript?.messages) || transcript.transcriptTruncated
        || !Number.isSafeInteger(transcript.totalMessages) || transcript.totalMessages !== transcript.messages.length) continue;
      const seed = transcript.messages.filter(m => m?.uuid === e.seedUuid);
      if (seed.length !== 1 || seed[0].type !== 'user' || seed[0].message?.role !== 'user'
        || seed[0].queueTranscriptOnly !== true || await digest(seed[0].message.content) !== e.seedContentDigest) continue;
      if (transcript.messages.some(m => ['user', 'assistant'].includes(m?.type) && m.uuid !== e.seedUuid)) continue;
      const preview = await native.previewCliResume(row.handle);
      if (preview?.resumable === true) matches.push(row);
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }
  function idle(s, e) {
    if (!s || s.sessionId !== e.localSessionId || s.cwd !== e.cwd || s.title !== e.title
      || s.lastActivityAt !== e.lastActivityAt || ['isArchived', 'isRunning', 'turnRunning'].some(k => s[k] !== false)) return false;
    if (['cliBootPending', 'starting', 'heldInput', 'sendsHeldAfterError', 'hasBackgroundActivity', 'hasBackgroundWork',
      'remoteTarget', 'pendingCwd', 'pendingCwdTrustPrompt', 'remoteControlConnecting', 'scheduledTaskId', 'agentDispatched',
      'lanyard', 'pendingRefusalFallbackPrompt', 'pendingAutoModeServerFallbackPrompt', 'pendingLanyardConsent',
      'pendingViolinBowPrompt', 'pendingRewind', 'isStopping', 'awaitingBrief', 'transcriptUnavailable',
      'pendingLoopWakeup', 'pendingScheduleWakeupIds'].some(k => s[k])) return false;
    return ['pendingToolPermissions', 'loops', 'spawningTaskIds'].every(k => s[k] === undefined || Array.isArray(s[k]) && s[k].length === 0);
  }
  async function activationReady(e) {
    const cut = e.registryPath.lastIndexOf('/');
    const mapped = decode(await native.readFileAtCwd(e.registryPath.slice(0, cut), e.registryPath.slice(cut + 1)), 8 * 1024 * 1024);
    if (mapped.sessionId !== e.localSessionId || mapped.cliSessionId !== e.cliSessionId || mapped.cwd !== e.cwd
      || mapped.title !== e.title || mapped.lastActivityAt !== e.lastActivityAt || mapped.isArchived !== false) return false;
    if (!idle(await native.getSession(e.localSessionId), e) || hasDraft(e.localSessionId)) return false;
    const busy = await native.getBusyShellPtyKeys(e.localSessionId, false);
    return busy?.probed === true && Array.isArray(busy.busy) && !busy.busy.length
      && Array.isArray(busy.unknown) && !busy.unknown.length && idle(await native.getSession(e.localSessionId), e);
  }
  async function resume(e, ticket) {
    const row = await candidate(e);
    if (!row || !await current(e, ticket)) { report('waiting-native-resume-preview'); return; }
    attempted.add(`${e.opId}:resume`);
    const claim = await call('claudex_local_adoption_claim', { opId: e.opId, handle: row.handle, cwd: e.cwd,
      seedUuid: e.seedUuid, seedContentDigest: e.seedContentDigest, resumable: true });
    if (claim?.ready !== true) { report('resume-claim-not-ready'); return; }
    if (claim.opId !== e.opId || claim.handle !== row.handle || claim.cliSessionId !== e.cliSessionId || !syncUuid(claim.claimId))
      throw new Error('Native resume claim changed');
    let outcome = 'rejected', localSessionId = null, reason = 'authority-changed';
    if (await current(e, ticket) && (await candidate(e))?.handle === row.handle && await current(e, ticket)) {
      outcome = 'unknown'; reason = null;
      try {
        const result = await native.resumeCliSession(row.handle);
        if (result?.ok === true && result.sessionId === `local_${e.cliSessionId}`) {
          outcome = 'resumed'; localSessionId = result.sessionId; report('resumed-awaiting-native-mapping');
        } else if (result?.ok === false && ['running', 'liveness_unknown', 'workspace_untrusted', 'folder_missing', 'failed'].includes(result.reason)) {
          outcome = 'rejected'; reason = result.reason; report('native-resume-refused');
        } else report('native-resume-unknown');
      } catch { report('native-resume-unknown'); }
    }
    await call('claudex_local_adoption_receipt', { opId: e.opId, claimId: claim.claimId, outcome, localSessionId, reason });
  }
  async function activate(e, ticket) {
    const commands = await native.getSupportedCommands({ sessionId: e.localSessionId });
    if (Array.isArray(commands) && commands.filter(c => c?.name === 'claudex-sync').length === 1) {
      report('native-mod-command-ready'); return;
    }
    if (!await activationReady(e) || !await current(e, ticket)) { report('waiting-native-activation-idle'); return; }
    attempted.add(`${e.opId}:activate`);
    const claim = await call('claudex_local_activation_claim', { opId: e.opId, localSessionId: e.localSessionId, lastActivityAt: e.lastActivityAt });
    if (claim?.ready !== true) { report('activation-claim-not-ready'); return; }
    if (claim.opId !== e.opId || claim.localSessionId !== e.localSessionId || claim.lastActivityAt !== e.lastActivityAt || !syncUuid(claim.claimId))
      throw new Error('Native activation claim changed');
    let outcome = 'rejected';
    if (await activationReady(e) && await current(e, ticket)) {
      outcome = 'unknown';
      try { await native.warmSession(e.localSessionId); outcome = 'returned'; report('native-activated-awaiting-mod'); }
      catch { report('native-activation-unknown'); }
    }
    await call('claudex_local_activation_receipt', { opId: e.opId, claimId: claim.claimId, outcome });
  }
  async function poll() {
    if (!running || inFlight) return;
    inFlight = true; const ticket = generation;
    try {
      const entries = await manifest();
      for (const e of entries) {
        if (!await current(e, ticket) || attempted.has(`${e.opId}:${e.action}`)) continue;
        client();
        const methods = e.action === 'resume' ? ['listResumableCliSessions', 'readCliTranscript', 'previewCliResume', 'resumeCliSession']
          : ['readFileAtCwd', 'getSession', 'getBusyShellPtyKeys', 'getSupportedCommands', 'warmSession'];
        if (methods.some(k => typeof native?.[k] !== 'function')) { report('native-adoption-api-unavailable'); continue; }
        if (e.action === 'resume') await resume(e, ticket); else await activate(e, ticket);
      }
    } catch { report('native-adoption-unavailable'); }
    finally { inFlight = false; if (running) timer = setTimer(poll, intervalMs); }
  }
  return { start() { if (!running) { running = true; generation++; report('started'); void poll(); } },
    stop() { running = false; generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; }, poll };
}
