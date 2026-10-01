/** Embedded only in the pinned Code component. Selection and native submit
 * callbacks provide identity, never prompt text. No global input interception.
 */
export function createClaudeOwnerWakeRuntime({ readMap, getClient, now = Date.now,
  onError = () => {}, onStatus = () => {} } = {}) {
  let running = false, generation = 0, lastError;
  let diagnosticWindow = now(), diagnosticCount = 0;
  const recent = new Map(), pending = new Set(), diagnostics = new Map();
  const remoteId = value => typeof value === 'string' && /^(?:cse_|session_)[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value.replace(/^session_/, 'cse_') : null;
  const error = message => {
    if (message !== lastError) { lastError = message; onError(message); }
  };
  // Only fixed stage/reason labels reach diagnostics. Native errors/receipts can
  // contain arbitrary text; never log them, IDs, paths or composer contents.
  const status = message => {
    const at = now();
    if (at - diagnosticWindow >= 30_000) { diagnosticWindow = at; diagnosticCount = 0; diagnostics.clear(); }
    if (diagnosticCount >= 64 || diagnostics.has(message) && at - diagnostics.get(message) < 1000) return;
    diagnostics.set(message, at); diagnosticCount++; onStatus(message);
  };
  const deferReasons = new Set(['application stopped', 'rate limited', 'pending transaction', 'folder map unavailable',
    'unpublished Remote Control identity', 'current owner unavailable or ambiguous', 'conversation is not tracked',
    'current owner identity changed', 'owner is blocked or transitioning', 'current conversation pair is unavailable or ambiguous',
    'current project identity changed', 'current project is unavailable or aliased', 'current native history is unavailable or aliased',
    'current project or history is unavailable']);
  const fail = reason => { throw new Error(reason); };
  async function signal(identity, source, sessionType) {
    source = source === 'submit' ? 'submit' : 'selection';
    const report = message => status(`signal ${source} ${message}`);
    const id = remoteId(identity), ticket = generation;
    if (!running) { report('ignored stopped'); return; }
    if (sessionType !== 'bridge') { report('ignored non-rc-session'); return; }
    if (!id) { report('ignored invalid-identity'); return; }
    if (pending.has(id)) { report('ignored pending'); return; }
    for (const [key, at] of recent) if (now() - at >= 30_000) recent.delete(key);
    if (recent.has(id) && now() - recent.get(id) < 5000) { report('ignored debounced'); return; }
    if (recent.size >= 16 || pending.size >= 16) { report('ignored rate-limited'); return; }
    recent.set(id, now()); pending.add(id);
    let failureReason = 'map-read-failed';
    try {
      report('received');
      if (typeof readMap !== 'function') fail(failureReason = 'map-api-unavailable');
      if (typeof getClient !== 'function') fail(failureReason = 'mcp-api-unavailable');
      const read = await readMap();
      if (!read || typeof read.contents !== 'string' || read.contents.length > 2 * 1024 * 1024 || read.isTail)
        fail(failureReason = 'map-unavailable-or-truncated');
      failureReason = 'map-invalid';
      const map = JSON.parse(read.contents);
      if (map?.version !== 1 || Object.keys(map).sort().join(',') !== 'entries,version'
        || !Array.isArray(map.entries) || map.entries.length > 4096) fail(failureReason);
      const ids = new Set();
      for (const row of map.entries) {
        if (!row || Object.keys(row).sort().join(',') !== 'canonicalCwd,remoteId,verified'
          || row.verified !== true || remoteId(row.remoteId) !== row.remoteId || ids.has(row.remoteId)
          || typeof row.canonicalCwd !== 'string' || !row.canonicalCwd.startsWith('/') || row.canonicalCwd.length > 4096
          || /[\x00-\x1f\x7f]/.test(row.canonicalCwd)) fail(failureReason = 'map-identity-invalid');
        ids.add(row.remoteId);
      }
      if (!running || ticket !== generation) { report('ignored stale-generation'); return; }
      if (!ids.has(id)) { report('ignored unpublished'); return; }
      report('matched published');
      report('mcp lookup');
      failureReason = 'mcp-lookup-failed';
      const client = getClient('claudex-desktop-wake');
      // The pinned native stdio attach uses a MessagePort transport. Native
      // Local/Cowork session proxy clients share this registry but do not have
      // that transport. Never borrow one, connect a server, or replace a client.
      const transport = client?.transport;
      if (!transport || transport._closed !== false || transport.pid !== null || transport.stderr !== null
        || typeof transport._port?.postMessage !== 'function' || typeof transport._port?.close !== 'function')
        fail(failureReason = 'mcp-not-connected');
      if (typeof client.callTool !== 'function' || client.getServerVersion?.()?.name !== 'claudex'
        || !client.getServerCapabilities?.()?.tools) fail(failureReason = 'mcp-client-unvalidated');
      report('mcp connected');
      if (!running || ticket !== generation) { report('ignored stale-generation'); return; }
      failureReason = 'mcp-call-failed';
      const result = await client.callTool({ name: 'claudex_desktop_owner_wake', arguments: { remoteId: id } });
      if (result?.isError) {
        // Native response text is untrusted; report only fixed refusal labels.
        const text = result.content?.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : null;
        failureReason = text === "Server 'claudex-desktop-wake' is not connected" ? 'mcp-not-connected'
          : text === "Access to 'claudex-desktop-wake' was not approved on this device" ? 'mcp-grant-refused' : 'mcp-refused';
        fail(failureReason);
      }
      report('called'); failureReason = 'receipt-invalid';
      let receipt = result?.structuredContent;
      if (!receipt) {
        const text = result?.content?.filter(item => item.type === 'text');
        if (text?.length !== 1 || typeof text[0].text !== 'string' || text[0].text.length > 2048)
          fail(failureReason);
        receipt = JSON.parse(text[0].text);
      }
      if (typeof receipt?.accepted !== 'boolean') fail(failureReason);
      if (!receipt.accepted) {
        const reason = deferReasons.has(receipt.reason) ? receipt.reason : 'not accepted';
        report(`deferred ${reason}`); error(`Owner wake deferred: ${reason}`);
      } else { report('accepted'); lastError = null; }
    } catch { report(`call failed ${failureReason}`); error(`Owner wake ${failureReason}`); }
    finally { pending.delete(id); }
  }
  return { signal, start() {
    running = true; generation++; status('started');
    status(`native APIs map=${typeof readMap === 'function' ? 'available' : 'unavailable'} mcp=${typeof getClient === 'function' ? 'available' : 'unavailable'}`);
  }, stop() { running = false; generation++; } };
}
