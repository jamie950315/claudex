const nativeId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const localId = value => typeof value === 'string' && value.startsWith('local_') && nativeId(value.slice(6));
const remoteId = value => typeof value === 'string' ? value.replace(/^session_/, 'cse_') : null;
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);

/** Native archive intent consumer. It never replaces a transcript or changes a
 * row's writer route. File proofs are established by the coordinator; live
 * native state is checked again immediately before the ordinary archive API.
 */
export function createClaudeDesktopHandoffRuntime({ readManifest, native, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 2000,
  onError = () => {}, onChange = () => {}, hasDraft = () => false, normalizeAnchor, registryRoot } = {}) {
  let running = false, timer, inFlight = false, generation = 0, rows = [], keys;
  let lastError = null;
  const attempted = new Set(), observedAnchors = new Map();
  const report = message => { if (lastError !== message) { lastError = message; onError(message); } };
  const safe = (session, action) => {
    if (!session || session.sessionId !== action.localSessionId || session.cwd !== action.cwd
      || session.title !== action.title || session.lastActivityAt !== action.expectedLastActivityAt)
      return 'Local session identity, title, directory, or activity changed';
    if (session.isArchived === true) return null;
    if ([session.bridgeSessionId, ...(session.bridgeSessionIds ?? [])].some(id => remoteId(id) === action.remoteId))
      return 'Local predecessor shares the replacement Remote Control identity';
    if (session.isRunning !== false || session.turnRunning !== false || session.cliBootPending
      || session.starting || session.heldInput || session.hasBackgroundActivity || session.hasBackgroundWork
      || session.remoteTarget || session.isStarred || session.spawnedFrom || session.forkedFromSessionId
      || session.pendingCwd || session.pendingCwdTrustPrompt || session.remoteControlConnecting
      || session.scheduledTaskId || session.agentDispatched || session.lanyard
      || session.pendingRefusalFallbackPrompt || session.pendingAutoModeServerFallbackPrompt
      || session.pendingLanyardConsent || session.pendingViolinBowPrompt
      || session.pendingToolPermissions !== undefined && (!Array.isArray(session.pendingToolPermissions) || session.pendingToolPermissions.length)
      || session.loops !== undefined && (!Array.isArray(session.loops) || session.loops.length)
      || session.spawningTaskIds?.length) return 'Local session has active, queued, dependent, or unverified work';
    return null;
  };
  const replacement = action => rows.some(row => row?.type === 'bridge'
    && remoteId(row.id) === action.remoteId && row.title === action.title && row.isArchived !== true);
  function parse(result) {
    if (!result || typeof result.contents !== 'string' || result.contents.length > 2 * 1024 * 1024 || result.isTail)
      throw new Error('Native handoff manifest is unavailable or truncated');
    const value = JSON.parse(result.contents);
    if (value?.version !== 1 || value.kind !== 'claude-local-archive'
      || !Array.isArray(value.actions) || value.actions.length > 32
      || !Array.isArray(value.anchors ?? []) || (value.anchors?.length ?? 0) > 4096)
      throw new Error('Native handoff manifest is invalid or expired');
    if (!value.actions.length) return value;
    if (!Number.isSafeInteger(value.generatedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.generatedAt > now() + 1000 || value.expiresAt - value.generatedAt > 30_000)
      throw new Error('Native handoff command lifetime is invalid');
    if (value.expiresAt <= now()) return { ...value, actions: [] };
    const seen = new Set();
    for (const action of value.actions) {
      if (!action || !nativeId(action.operationId)
        || !nativeId(action.conversationId) || !localId(action.localSessionId) || !nativeId(action.nativeId)
        || !/^cse_[A-Za-z0-9_-]{1,200}$/.test(action.remoteId) || !boundedText(action.cwd) || !action.cwd.startsWith('/')
        || !boundedText(action.title) || !Number.isSafeInteger(action.expectedLastActivityAt)
        || !boundedText(action.registryProof?.path) || !boundedText(registryRoot)
        || !action.registryProof.path.startsWith(`${registryRoot}/`)
        || action.registryProof.path.split('/').some(part => part === '..' || part === '.')
        || !action.registryProof.path.endsWith(`/${action.localSessionId}.json`)
        || !action.originalProof || !/^[a-f0-9]{64}$/.test(action.originalProof.sha256)
        || !Number.isSafeInteger(action.originalProof.bytes) || action.originalProof.bytes < 1
        || seen.has(action.localSessionId)) throw new Error('Native handoff action is malformed or ambiguous');
      seen.add(action.localSessionId);
    }
    return value;
  }
  function rememberAnchors(manifest) {
    const permitted = new Set((manifest.anchors ?? []).map(anchor => anchor.localSessionId));
    for (const id of observedAnchors.keys()) if (!permitted.has(id)) { observedAnchors.delete(id); onChange(); }
    for (const anchor of manifest.anchors ?? []) {
      if (!localId(anchor?.localSessionId) || !boundedText(anchor.cwd) || !/^cse_[A-Za-z0-9_-]{1,200}$/.test(anchor.remoteId)) continue;
      const row = rows.find(row => row?.type === 'local' && row.id === anchor.localSessionId
        && [row.cwd, row.diffCwd, row.harnessCwd].includes(anchor.cwd));
      if (!row || typeof keys !== 'function' || !boundedText(keys(row)) || !boundedText(row.repoInfo?.name)) continue;
      const prior = observedAnchors.get(anchor.localSessionId);
      if (prior?.key === keys(row) && prior?.label === row.repoInfo.name) continue;
      observedAnchors.set(anchor.localSessionId, { row, key: keys(row), label: row.repoInfo.name,
        identity: JSON.stringify(anchor), verifiedAt: now() });
      onChange();
    }
  }
  async function hydrateAnchors(manifest) {
    if (typeof normalizeAnchor !== 'function' || typeof native?.getGitInfo !== 'function' || typeof keys !== 'function') return;
    let reads = 0;
    for (const anchor of manifest.anchors ?? []) {
      if (!localId(anchor?.localSessionId) || !nativeId(anchor.nativeId) || !nativeId(anchor.replacementNativeId)
        || !boundedText(anchor.cwd) || !anchor.cwd.startsWith('/') || !/^cse_[A-Za-z0-9_-]{1,200}$/.test(anchor.remoteId)) continue;
      if (!rows.some(row => row?.type === 'bridge' && remoteId(row.id) === anchor.remoteId)) continue;
      const identity = JSON.stringify(anchor), previous = observedAnchors.get(anchor.localSessionId);
      if (previous?.identity === identity && now() - previous.verifiedAt < 60_000) continue;
      if (reads++ >= 4) break;
      const session = await native.getSession(anchor.localSessionId);
      if (!session || session.sessionId !== anchor.localSessionId) {
        if (observedAnchors.delete(anchor.localSessionId)) onChange();
        continue;
      }
      const path = session.harnessCwd || session.cwd, origin = session.originCwd || session.cwd;
      const gitInfo = await native.getGitInfo(path);
      const originGitInfo = origin === path ? gitInfo : await native.getGitInfo(origin);
      const row = normalizeAnchor({ session, anchor, gitInfo, originGitInfo });
      if (!row || !boundedText(keys(row)) || !boundedText(row.repoInfo?.name)) {
        if (observedAnchors.delete(anchor.localSessionId)) onChange();
        continue;
      }
      const next = { row, key: keys(row), label: row.repoInfo.name, identity, verifiedAt: now() };
      observedAnchors.set(anchor.localSessionId, next);
      if (!previous || previous.key !== next.key || previous.label !== next.label || previous.identity !== identity) onChange();
    }
  }
  async function poll() {
    if (!running || inFlight || typeof readManifest !== 'function') return;
    inFlight = true; const ticket = generation;
    try {
      const manifest = parse(await readManifest());
      if (!running || ticket !== generation) return;
      rememberAnchors(manifest);
      if (['getSession', 'getSessionList', 'getBusyShellPtyKeys', 'readFileAtCwd', 'archive'].some(name => typeof native?.[name] !== 'function'))
        throw new Error('Native Local session archive API is unavailable');
      await hydrateAnchors(manifest);
      for (const action of manifest.actions) {
        if (!running || ticket !== generation || now() >= manifest.expiresAt) break;
        if (attempted.has(action.operationId) || !replacement(action)) continue;
        const original = await native.getSession(action.localSessionId);
        const refusal = safe(original, action);
        if (refusal) { report(refusal); continue; }
        if (original.isArchived) { attempted.add(action.operationId); continue; }
        const listing = await native.getSessionList();
        if (!Array.isArray(listing?.sessions) || listing.sessions.length > 16_384)
          throw new Error('Native session dependency inventory is unavailable');
        if (listing.sessions.some(row => row?.isArchived !== true
          && (row.spawnedFrom?.sessionId === action.localSessionId || row.forkedFromSessionId === action.localSessionId))) {
          report('Local session has a live dependent session'); continue;
        }
        if (hasDraft(action.localSessionId)) { report('Local session has an unsent draft'); continue; }
        const terminals = await native.getBusyShellPtyKeys(action.localSessionId, false);
        if (terminals?.probed !== true || !Array.isArray(terminals.busy) || terminals.busy.length
          || !Array.isArray(terminals.unknown) || terminals.unknown.length) {
          report('Local session has busy or unverified terminal work'); continue;
        }
        const registryPath = action.registryProof.path, separator = registryPath.lastIndexOf('/');
        const persisted = await native.readFileAtCwd(registryPath.slice(0, separator), registryPath.slice(separator + 1));
        if (!persisted || typeof persisted.contents !== 'string' || persisted.isTail || persisted.contents.length > 8 * 1024 * 1024)
          throw new Error('Native Local identity mapping is unavailable or truncated');
        const mapped = JSON.parse(persisted.contents);
        if (mapped.sessionId !== action.localSessionId || mapped.cliSessionId !== action.nativeId
          || mapped.cwd !== action.cwd || mapped.title !== action.title
          || mapped.lastActivityAt !== action.expectedLastActivityAt || mapped.isArchived !== false) {
          report('Native Local mapping changed its CLI session identity or activity'); continue;
        }
        const current = await native.getSession(action.localSessionId);
        const changed = safe(current, action);
        if (changed) { report(changed); continue; }
        const latest = parse(await readManifest());
        const stillAuthorized = latest.actions.some(candidate => JSON.stringify(candidate) === JSON.stringify(action));
        if (!stillAuthorized || !replacement(action) || !running || ticket !== generation || hasDraft(action.localSessionId)) continue;
        attempted.add(action.operationId);
        // Keep worktrees and original files. This is the native reversible
        // archive action, never a delete or a foreign transcript append.
        await native.archive(action.localSessionId, { cleanupWorktree: false, forceWorktreeCleanup: false });
        const archived = await native.getSession(action.localSessionId);
        if (archived?.sessionId !== action.localSessionId || archived.isArchived !== true)
          throw new Error('Native Local archive outcome is not verified');
        lastError = null;
        break; // A bounded, serial action per poll; never monopolize the renderer.
      }
      const activeOperations = new Set(manifest.actions.map(action => action.operationId));
      for (const operationId of attempted) if (!activeOperations.has(operationId)) attempted.delete(operationId);
    } catch (error) { report(String(error?.message ?? error).slice(0, 300)); }
    finally { inFlight = false; if (running) timer = setTimer(poll, intervalMs); }
  }
  return {
    start() { if (!running) { running = true; generation++; void poll(); } },
    stop() { running = false; generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; },
    setRows(value, projectKey) { if (Array.isArray(value)) rows = value; keys = projectKey; },
    projectionRows() { return [...observedAnchors.values()].map(value => value.row); },
    poll,
  };
}
