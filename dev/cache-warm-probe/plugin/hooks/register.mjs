// This development-only plugin never sends a message into the main conversation.
async function record($, root, arm, rows, event) {
  if (rows.length >= 32) throw new Error('Probe record limit reached.');
  rows.push({ at: await $.clock.now(), ...event });
  await $.fs.write(`${root}/probe.json`, JSON.stringify({ arm, rows }));
}

export function register(on) {
  let root, arm, started = false, ended = false, busy = false, firstRequestAt = null;
  let strategy = 'fork';
  let timer = null, forkStarted = false;
  const rows = [];
  on('session.start', async ($, e, next) => {
    root = await $.session.cwd();
    arm = await $.env.get('CLAUDEX_CACHE_PROBE_ARM');
    strategy = await $.env.get('CLAUDEX_CACHE_PROBE_STRATEGY') ?? 'fork';
    if (await $.env.get('CLAUDEX_CACHE_PROBE_AUTHORIZED') !== '1' || !['control', 'warm'].includes(arm)) return next(e);
    started = true;
    await record($, root, arm, rows, { kind: 'loaded', strategy, version: await $.session.version(), model: await $.session.model() });
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (started && !ended) {
      const now = await $.clock.now();
      if (!e.agentId && firstRequestAt === null) firstRequestAt = now;
      await record($, root, arm, rows, { kind: 'request', main: !e.agentId, index: e.index, model: e.model, effort: e.effort ?? null });
    }
    return yield* next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (started) busy = true;
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!started || ended || e.agentId) return result;
    busy = false;
    await record($, root, arm, rows, { kind: 'main-complete', reason: e.reason, usage: e.usage ?? null });
    if (strategy !== 'fork' || arm !== 'warm' || timer !== null || forkStarted || firstRequestAt === null || e.reason !== 'answer') return result;
    const due = firstRequestAt + 240000;
    if (due <= await $.clock.now()) { await record($, root, arm, rows, { kind: 'refused', reason: 'seed-too-slow' }); return result; }
    timer = $.clock.after(due - await $.clock.now(), async () => {
      if (ended || busy || forkStarted) return;
      forkStarted = true; // No retry, including a missing or uncertain receipt.
      const before = JSON.stringify(await $.session.messages({ as: 'api' }));
      await record($, root, arm, rows, { kind: 'fork-start', mainBytes: before.length });
      const reply = await $.model.fork({ prompt: 'Cache-retention measurement only. Reply with exactly OK. Do not call tools.' });
      const after = JSON.stringify(await $.session.messages({ as: 'api' }));
      await record($, root, arm, rows, { kind: 'fork-result', isAnswered: reply.isAnswered,
        reason: reply.isAnswered ? null : reply.reason, usage: reply.usage ?? null,
        mainUnchanged: before === after, mainBytes: after.length,
        replyIsOK: reply.isAnswered && reply.text.trim() === 'OK' });
    });
    await record($, root, arm, rows, { kind: 'scheduled', due });
    return result;
  });
  on('session.end', async ($, e, next) => {
    ended = true;
    timer?.cancel();
    if (started) await record($, root, arm, rows, { kind: 'ended' });
    return next(e);
  });
}
