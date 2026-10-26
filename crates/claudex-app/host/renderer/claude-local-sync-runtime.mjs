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
  function idleReason(session, entry) {
    if (!session) return 'native-session-missing';
    if (session.sessionId !== entry.localSessionId || session.cwd !== entry.cwd || session.title !== entry.title)
      return 'native-session-identity-mismatch';
    if (session.isArchived !== false) return 'waiting-native-archive-state';
    if (session.isRunning !== false) return 'waiting-native-running-state';
    if (session.turnRunning !== false) return 'waiting-native-turn-state';
    if (!Number.isSafeInteger(session.lastActivityAt)) return 'native-last-activity-unverified';
    // Native warmSession leaves this marker true until the first system/init
    // turn frame, even after control initialization and Mod registration.
    // Defer only that exact boolean to the live command proof in inspect();
    // these activity checks alone never make the session dispatch-ready.
    if (session.cliBootPending && session.cliBootPending !== true) return 'waiting-native-cliBootPending';
    const pending = ['starting', 'heldInput', 'hasBackgroundActivity', 'hasBackgroundWork',
      'remoteTarget', 'pendingCwd', 'pendingCwdTrustPrompt', 'remoteControlConnecting', 'scheduledTaskId',
      'agentDispatched', 'lanyard', 'pendingRefusalFallbackPrompt', 'pendingAutoModeServerFallbackPrompt',
      'pendingLanyardConsent', 'pendingViolinBowPrompt', 'pendingRewind', 'isStopping'].find(key => session[key]);
    // This suffix comes only from the fixed list above, never native content.
    if (pending) return `waiting-native-${pending}`;
    for (const key of ['pendingToolPermissions', 'loops', 'spawningTaskIds'])
      if (session[key] !== undefined && (!Array.isArray(session[key]) || session[key].length)) return `waiting-native-${key}`;
    return null;
  }
  async function inspect(entry) {
    const refused = code => { report(code); return null; };
    const cut = entry.registryPath.lastIndexOf('/');
    let mapped;
    try { mapped = decode(await native.readFileAtCwd(entry.registryPath.slice(0, cut), entry.registryPath.slice(cut + 1)), 8 * 1024 * 1024); }
    catch { return refused('waiting-registry-metadata'); }
    if (mapped.sessionId !== entry.localSessionId || mapped.cliSessionId !== entry.cliSessionId
      || mapped.cwd !== entry.cwd || mapped.title !== entry.title || mapped.isArchived !== false) return refused('registry-identity-mismatch');
    let session;
    try { session = await native.getSession(entry.localSessionId); }
    catch { return refused('waiting-native-session'); }
    const reason = idleReason(session, entry);
    if (reason) return refused(reason);
    if (session.lastActivityAt !== mapped.lastActivityAt) return refused('native-registry-activity-mismatch');
    if (hasDraft(entry.localSessionId)) return refused('waiting-composer-draft');
    let busy;
    try { busy = await native.getBusyShellPtyKeys(entry.localSessionId, false); }
    catch { return refused('waiting-native-shell-metadata'); }
    if (busy?.probed !== true || !Array.isArray(busy.busy) || busy.busy.length
      || !Array.isArray(busy.unknown) || busy.unknown.length) return refused('waiting-native-shells');
    // A cold catalogue does not run Mod registration. Never submit an unknown
    // slash command: native would otherwise treat it as an ordinary prompt.
    let commands;
    try { commands = await native.getSupportedCommands({ sessionId: entry.localSessionId }); }
    catch { return refused('waiting-native-command-catalogue'); }
    if (!Array.isArray(commands)) return refused('native-command-catalogue-unavailable');
    const commandCount = commands.filter(command => command?.name === entry.command).length;
    if (commandCount !== 1) return refused(commandCount ? 'native-command-duplicate' : 'native-command-missing');
    // The exact registered command proves the live CLI's control initialize
    // completed. A cold catalogue disables hooks and cannot register it. This
    // proof is required on every inspect, including both sides of the claim;
    // cliBootPending alone is never accepted as initialization evidence.
    let current;
    try { current = await native.getSession(entry.localSessionId); }
    catch { return refused('waiting-native-session-recheck'); }
    const currentReason = idleReason(current, entry);
    if (currentReason) return refused(currentReason);
    if (current.lastActivityAt !== session.lastActivityAt) return refused('native-session-activity-changed');
    return current;
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
          if (!before) continue;
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

/** Native folderless prewarm -> proven fixed Mod bootstrap -> normal cwd move.
 * Every side effect consumes a durable claim; an unknown action is never retried.
 */
export function createClaudeLocalStartRuntime({ readManifest, native, getClient, registryRoot,
  hasDraft = () => true, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, intervalMs = 2000, onStatus = () => {} } = {}) {
  let running = false, generation = 0, inFlight = false, timer, lastStatus, apiReady = false;
  const attempted = new Set();
  const report = code => { if (lastStatus !== code) { lastStatus = code; try { onStatus(code); } catch {} } };
  const decode = (result, limit) => {
    if (!result || typeof result.contents !== 'string' || result.isTail || result.contents.length > limit)
      throw new Error('Native Local metadata unavailable');
    return JSON.parse(result.contents);
  };
  async function manifest() {
    const value = decode(await readManifest(), 256 * 1024);
    if (value?.version !== 3 || !Array.isArray(value.entries) || value.entries.length > 1)
      throw new Error('Native Local manifest invalid');
    for (const e of value.entries) {
      if (!syncPath(registryRoot) || e.registryRoot !== registryRoot
        || !['prewarm', 'start', 'move', 'witness'].includes(e.stage) || !syncUuid(e.opId) || !syncPath(e.cwd)
        || !syncText(e.title) || e.command !== (e.stage === 'witness' ? 'claudex-witness' : 'claudex-bootstrap') || !Number.isSafeInteger(e.expiresAt))
        throw new Error('Native Local identity invalid');
      if (e.stage !== 'prewarm' && (!syncPath(e.prewarm?.cwd) || !e.prewarm.sessionId?.startsWith('local_')
        || !syncUuid(e.prewarm.sessionId.slice(6)))) throw new Error('Native prewarm receipt invalid');
      const context = e.stage === 'witness' ? e.witnessContext : (e.identity ?? e.bootstrap);
      if (e.stage === 'witness' && !syncUuid(e.inputUuid)) throw new Error('Native witness input identity invalid');
      if (['move', 'witness'].includes(e.stage) && (!syncUuid(context?.sessionId) || context.cwd !== e.prewarm.cwd
        || !syncPath(e.mapping?.registryPath) || !e.mapping.registryPath.startsWith(`${registryRoot}/`)
        || !e.mapping.registryPath.endsWith(`/${e.prewarm.sessionId}.json`)
        || e.mapping.sessionId !== e.prewarm.sessionId || e.mapping.nativeId !== context.sessionId
        || e.mapping.cwd !== e.prewarm.cwd || !Number.isSafeInteger(e.mapping.lastActivityAt)))
        throw new Error('Native bootstrap mapping invalid');
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
    if (result?.isError) throw new Error('Native Local authority refused');
    if (result?.structuredContent) return result.structuredContent;
    const texts = result?.content?.filter(x => x.type === 'text');
    if (texts?.length !== 1 || typeof texts[0].text !== 'string' || texts[0].text.length > 32768)
      throw new Error('Native Local receipt unavailable');
    return JSON.parse(texts[0].text);
  }
  async function current(e, ticket) {
    return running && ticket === generation && e.registryRoot === registryRoot
      && e.expiresAt > now() && !hasDraft(e.prewarm?.sessionId)
      && (await manifest()).some(v => JSON.stringify(v) === JSON.stringify(e))
      && running && ticket === generation && !hasDraft(e.prewarm?.sessionId);
  }
  async function catalogue(e) {
    const kind = e.stage === 'witness' ? 'witness' : 'bootstrap';
    const commands = await native.getSupportedCommands({ sessionId: e.prewarm.sessionId });
    if (!Array.isArray(commands)) { report(`${kind}-catalogue-unavailable`); return false; }
    const count = commands.filter(c => c?.name === e.command).length;
    report(`${kind}-catalogue-${count === 1 ? 'ready' : count ? 'duplicate' : 'missing'}`);
    return count === 1;
  }
  async function moveProof(e) {
    const context = e.stage === 'witness' ? e.witnessContext : (e.identity ?? e.bootstrap);
    const p = e.mapping.registryPath, cut = p.lastIndexOf('/');
    const m = decode(await native.readFileAtCwd(p.slice(0, cut), p.slice(cut + 1)), 8 * 1024 * 1024);
    if (m.sessionId !== e.prewarm.sessionId || m.cliSessionId !== context.sessionId
      || m.cwd !== e.prewarm.cwd || m.isArchived !== false || m.title !== e.title || m.lastActivityAt !== e.mapping.lastActivityAt) {
      report('cwd-registry-identity-changed'); return null;
    }
    const s = await native.getSession(e.prewarm.sessionId);
    // Identify the first refused predicate without logging native metadata.
    // An input-free warm retains cliBootPending until its first system/init.
    // Only witness may defer the exact boolean to its live registered command
    // proof on both sides of the claim. Ordinary move retains its strict guard.
    const reason = !s ? 'cwd-native-session-missing'
      : s.sessionId !== m.sessionId ? 'cwd-native-session-identity-mismatch'
      : s.cwd !== m.cwd ? 'cwd-native-session-cwd-mismatch'
      : s.title !== e.title ? 'cwd-native-session-title-mismatch'
      : s.isArchived !== false ? 'cwd-waiting-native-archive-state'
      : s.isRunning !== false ? 'cwd-waiting-native-running-state'
      : s.turnRunning !== false ? 'cwd-waiting-native-turn-state'
      : s.lastActivityAt !== m.lastActivityAt ? 'cwd-native-registry-activity-mismatch' : null;
    if (reason) { report(reason); return null; }
    const pending = ['cliBootPending', 'starting', 'heldInput', 'hasBackgroundActivity', 'hasBackgroundWork', 'remoteTarget',
      'pendingCwd', 'pendingCwdTrustPrompt', 'remoteControlConnecting', 'scheduledTaskId', 'agentDispatched',
      'pendingRefusalFallbackPrompt', 'pendingAutoModeServerFallbackPrompt', 'pendingLanyardConsent',
      'pendingViolinBowPrompt', 'pendingRewind', 'isStopping', 'lanyard']
      .find(k => s[k] && !(k === 'cliBootPending' && e.stage === 'witness' && s[k] === true));
    if (pending) { report(`cwd-waiting-native-${pending}`); return null; }
    const activity = ['pendingToolPermissions', 'loops', 'spawningTaskIds']
      .find(k => s[k] !== undefined && (!Array.isArray(s[k]) || s[k].length));
    if (activity) { report(`cwd-waiting-native-${activity}`); return null; }
    const busy = await native.getBusyShellPtyKeys(s.sessionId, false);
    if (busy?.probed !== true || !Array.isArray(busy.busy) || busy.busy.length || !Array.isArray(busy.unknown) || busy.unknown.length) {
      report('cwd-waiting-native-shells'); return null;
    }
    report('cwd-native-identity-ready');
    return { sessionId: m.sessionId, cliSessionId: m.cliSessionId, cwd: m.cwd, lastActivityAt: m.lastActivityAt };
  }
  async function poll() {
    if (!running || inFlight) return;
    inFlight = true; const ticket = generation;
    try {
      if (['prewarmFolderless', 'start', 'getSupportedCommands', 'changeCwd', 'getSession', 'getBusyShellPtyKeys', 'readFileAtCwd']
        .some(k => typeof native?.[k] !== 'function')) { report('native-start-api-unavailable'); return; }
      if (!apiReady) { apiReady = true; report('native-start-api-ready'); }
      for (const e of await manifest()) {
        const key = `${e.opId}:${e.stage}`;
        if (attempted.has(key) || !await current(e, ticket)) continue;
        let proof = { options: { cwd: '', message: '', useWorktree: false } };
        if (e.stage === 'start') {
          if (!await catalogue(e)) continue;
          proof = { sessionId: e.prewarm.sessionId, cwd: e.prewarm.cwd, command: e.command, unique: true };
        } else if (['move', 'witness'].includes(e.stage)) {
          proof = await moveProof(e); if (!proof) continue;
          if (e.stage === 'witness') {
            if (typeof native.sendMessage !== 'function' || !await catalogue(e)) continue;
            // The awaited live catalogue is initialization proof, not an idle
            // snapshot. Recheck activity and every other guard before claiming.
            const currentProof = await moveProof(e);
            if (!currentProof || JSON.stringify(currentProof) !== JSON.stringify(proof)) continue;
            proof = { ...currentProof, command: e.command, unique: true };
          }
        }
        if (!await current(e, ticket)) continue;
        client(); attempted.add(key);
        const claim = await call('claudex_local_start_claim', { opId: e.opId, stage: e.stage, proof });
        if (claim?.ready !== true) { report(`${e.stage}-claim-not-ready`); continue; }
        if (claim.opId !== e.opId || claim.stage !== e.stage || !syncUuid(claim.claimId)) throw new Error('Native Local claim changed');
        report(`${e.stage}-claimed`);
        let outcome = 'rejected', result = null;
        // Last lifecycle/catalogue/registry checks occur after the durable claim.
        let permitted = false;
        try {
          permitted = await current(e, ticket);
          if (permitted && e.stage === 'start') permitted = await catalogue(e);
          if (permitted && ['move', 'witness'].includes(e.stage)) {
            let currentProof = await moveProof(e);
            if (e.stage === 'witness') {
              permitted = !!currentProof && await catalogue(e);
              // Catalogue awaits can race activity, drafts and profile changes.
              if (permitted) currentProof = await moveProof(e);
              currentProof = currentProof && { ...currentProof, command: e.command, unique: true };
            }
            permitted = permitted && JSON.stringify(currentProof) === JSON.stringify(proof);
          }
          if (permitted) permitted = await current(e, ticket);
        } catch { permitted = false; report('native-start-authority-changed'); }
        if (permitted) {
          outcome = 'unknown';
          try {
            if (e.stage === 'prewarm') {
              const value = await native.prewarmFolderless(proof.options);
              if (value?.sessionId?.startsWith('local_') && syncUuid(value.sessionId.slice(6)) && syncPath(value.cwd)) {
                outcome = 'returned'; result = { sessionId: value.sessionId, cwd: value.cwd };
              } else if (typeof value?.refusedReason === 'string') outcome = 'rejected';
            } else if (e.stage === 'start') {
              const value = await native.start({ sessionId: e.prewarm.sessionId, cwd: e.prewarm.cwd, useWorktree: false,
                title: e.title, message: `/${e.command} ${e.opId} ${claim.claimId}` });
              if (value?.sessionId === e.prewarm.sessionId) { outcome = 'returned'; result = { sessionId: value.sessionId }; }
            } else if (e.stage === 'witness') {
              await native.sendMessage(e.prewarm.sessionId, `/${e.command} ${e.opId} ${claim.claimId}`,
                undefined, undefined, undefined, undefined, undefined, e.inputUuid);
              outcome = 'returned'; result = { sessionId: e.prewarm.sessionId };
            } else {
              const value = await native.changeCwd(e.prewarm.sessionId, e.cwd, false);
              if (value?.status === 'ok' && value.cwd === e.cwd) { outcome = 'returned'; result = { status: 'ok', cwd: value.cwd }; }
              else if (value?.status === 'needs_trust') outcome = 'needs_trust';
              else if (value?.status === 'rejected') outcome = 'rejected';
            }
          } catch { /* The durable claim remains consumed even if IPC loses its answer. */ }
        }
        report(`${e.stage}-${outcome}`);
        await call('claudex_local_start_receipt', { opId: e.opId, stage: e.stage, claimId: claim.claimId, outcome, result });
        break;
      }
    } catch { report('native-start-metadata-or-authority-unavailable'); }
    finally { inFlight = false; if (running) timer = setTimer(poll, intervalMs); }
  }
  return {
    start() { if (!running) { running = true; generation++; report('started'); void poll(); } },
    stop() { running = false; generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; }, poll,
  };
}
