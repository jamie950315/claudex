// Pure, offline assessment. A timer firing or an answered fork is not success.
export function assessEvidence(report) {
  const control = report.arms?.control, warm = report.arms?.warm;
  const fork = warm?.probe?.rows?.find(row => row.kind === 'fork-result');
  if (!fork) return { status: 'inconclusive', reason: 'no-fork-receipt' };
  if (!fork.isAnswered || fork.mainUnchanged !== true)
    return { status: 'refused', reason: 'fork-failed-or-main-changed' };
  const seed = warm.receipts?.[0]?.usage?.cache_creation_input_tokens;
  if (!Number.isSafeInteger(seed) || seed <= 1024)
    return { status: 'inconclusive', reason: 'no-measurable-seed' };
  if (!(fork.usage?.cache_read_input_tokens >= seed))
    return { status: 'not-established', reason: 'fork-did-not-reuse-complete-seed-prefix',
      seedWriteTokens: seed, forkReadTokens: fork.usage?.cache_read_input_tokens ?? null,
      forkWriteTokens: fork.usage?.cache_creation_input_tokens ?? null, mainUnchanged: true };
  const warmRequests = warm.probe.rows.filter(row => row.kind === 'request' && row.main);
  const controlRequests = control?.probe?.rows?.filter(row => row.kind === 'request' && row.main) ?? [];
  const warmFinal = warm.receipts?.[1]?.usage, controlFinal = control?.receipts?.[1]?.usage;
  if (!warmFinal || !controlFinal || warmRequests.length !== 2 || controlRequests.length !== 2)
    return { status: 'inconclusive', reason: 'no-post-expiry-comparison' };
  if (![warmRequests, controlRequests].every(rows => rows[1].at - rows[0].at > 300000))
    return { status: 'inconclusive', reason: 'original-ttl-not-crossed' };
  const controlSeed = control.receipts[0].usage.cache_creation_input_tokens;
  if (![controlSeed, warmFinal.cache_read_input_tokens, warmFinal.cache_creation_input_tokens,
    controlFinal.cache_read_input_tokens, controlFinal.cache_creation_input_tokens]
    .every(value => Number.isSafeInteger(value) && value >= 0) || controlSeed <= 1024)
    return { status: 'inconclusive', reason: 'invalid-post-expiry-usage' };
  if (warmFinal.cache_read_input_tokens < seed || controlFinal.cache_read_input_tokens !== 0
    || controlFinal.cache_creation_input_tokens < controlSeed)
    return { status: 'inconclusive', reason: 'control-or-prefix-comparison-not-distinct' };
  if (control.childExited !== true || warm.childExited !== true)
    return { status: 'inconclusive', reason: 'owned-process-exit-not-confirmed' };
  return { status: 'demonstrated-in-isolated-cli', reason: 'full-prefix-reused-after-original-ttl-with-cold-control',
    seedWriteTokens: seed, forkReadTokens: fork.usage.cache_read_input_tokens,
    finalWarmReadTokens: warmFinal.cache_read_input_tokens, finalControlReadTokens: controlFinal.cache_read_input_tokens };
}
