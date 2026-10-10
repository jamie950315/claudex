// Read-only presentation and limit parsing shared by native local commands. No scheduling or inference.
export const WARM_LIMIT_HELP = 'rounds=N (1-100), for=90m|3h|1h30m (up to 24h) or until=HH:MM (24-hour local time)';

/** Turn the user's own limits into the existing maxMinutes/maxRefreshes bounds.
 * rounds is a number of warm requests, for a duration and until the next local
 * HH:MM. A time limit alone allows as many requests as fit in it; rounds alone
 * may take up to a day. Returns the remaining words and any derived bounds. */
export function parseWarmLimits(words, { intervalMinutes, now }) {
  const rest = [], seen = new Map();
  for (const word of words) {
    const match = /^(rounds|for|until)=(.*)$/.exec(word);
    if (!match) { rest.push(word); continue; }
    if (seen.has(match[1])) throw new Error(`Use ${match[1]}= once. Limits: ${WARM_LIMIT_HELP}.`);
    seen.set(match[1], match[2]);
  }
  if (!seen.size) return { rest, bounds: {} };
  const invalid = () => new Error(`Limits: ${WARM_LIMIT_HELP}.`);
  if (seen.has('for') && seen.has('until')) throw new Error('Use either for= or until=, not both.');
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || !Number.isFinite(now)) throw invalid();
  let rounds, minutes;
  if (seen.has('rounds')) {
    if (!/^[1-9][0-9]{0,2}$/.test(seen.get('rounds')) || (rounds = Number(seen.get('rounds'))) > 100) throw invalid();
  }
  if (seen.has('for')) {
    const duration = /^(?:([0-9]{1,2})h)?(?:([0-9]{1,4})m)?$/.exec(seen.get('for'));
    if (!duration || duration[1] === undefined && duration[2] === undefined) throw invalid();
    minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0);
  } else if (seen.has('until')) {
    const clock = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(seen.get('until'));
    if (!clock) throw invalid();
    const target = new Date(now); target.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    // A time that has already passed today means the same time tomorrow.
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    minutes = Math.ceil((target.getTime() - now) / 60000);
  }
  if (minutes !== undefined) {
    if (minutes < 1 || minutes > 1440) throw invalid();
    if (minutes < intervalMinutes)
      throw new Error(`No warm request fits in ${minutes} min: the first one is due ${intervalMinutes} min after a reply.`);
    const fitting = Math.floor(minutes / intervalMinutes);
    if (rounds === undefined && fitting > 100)
      throw new Error(`${minutes} min would take ${fitting} warm requests; the limit is 100 (${100 * intervalMinutes} min at this interval).`);
    return { rest, bounds: { maxMinutes: minutes, maxRefreshes: rounds ?? fitting } };
  }
  return { rest, bounds: { maxMinutes: 1440, maxRefreshes: rounds } };
}
const number = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());
const interpolate = (key, params = {}) => key.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name) => params[name] ?? match);
const reasons = {
  disabled: 'Stopped',
  'awaiting-evidence': 'Waiting for a normal reply',
  'awaiting-native-settings': 'Waiting for a normal reply',
  'awaiting-native-binding': 'Waiting for the native session',
  busy: 'Waiting for the current turn',
  'attempt-pending': 'Warming in progress',
  'duration-limit': 'Time limit reached',
  'refresh-limit': 'Refresh limit reached',
  'read-budget': 'Token budget reached',
  'output-budget': 'Token budget reached',
  'actual-budget-exceeded': 'Token budget reached',
  'cache-expired': 'Cache evidence expired',
  'no-cache-prefix': 'No cacheable prefix observed',
  'native-output-not-complete': 'Waiting for a completed reply',
  'app-stopped': 'Stopped by app',
  'broker-stopping': 'Stopped',
  'broker-stopped': 'Stopped',
  'broker-restarted': 'Stopped',
  'native-ended': 'Session ended',
  'native-binding-changed': 'Session changed',
  'native-configuration-changed': 'Settings changed',
  'native-activity-changed': 'Activity changed',
  'native-uncertain': 'Delivery uncertain; stopped',
  uncertain: 'Delivery uncertain; stopped',
};
const terminal = new Set(['duration-limit', 'refresh-limit', 'read-budget', 'output-budget', 'actual-budget-exceeded',
  'cache-expired', 'native-ended', 'broker-stopping', 'broker-stopped', 'broker-restarted', 'app-stopped']);

// Date getters work in the native Mod runtime without depending on Intl support.
export function formatWarmTime(value) {
  if (!timestamp(value)) return null;
  const date = new Date(value), pad = n => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset(), absolute = Math.abs(offset);
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function formatWarmSummary(result = {}, { provider, sessionId, cwd, t = interpolate, formatTime = formatWarmTime } = {}) {
  result ??= {};
  const matches = policy => policy && (!sessionId || policy.sessionId === sessionId) && (!cwd || policy.cwd === cwd)
    && (!provider || !policy.provider || policy.provider === provider);
  // Never select an arbitrary entry from the broker's cross-session list.
  const policy = matches(result.policy) ? result.policy : sessionId && cwd && Array.isArray(result.policies)
    ? result.policies.find(matches) : null;
  const contextMatches = (!result.sessionId || !sessionId || result.sessionId === sessionId)
    && (!result.cwd || !cwd || result.cwd === cwd) && (!result.policy || Boolean(policy));
  const local = contextMatches && (!result.local?.sessionId || !sessionId || result.local.sessionId === sessionId) ? result.local : null;
  const policyReason = policy?.reason ?? policy?.status ?? 'disabled';
  const enabled = policy?.enabled === true && local?.enabled !== false;
  const localReason = local?.phase && local.phase !== 'idle'
    ? local.phase === 'ended' ? 'native-ended' : 'busy'
    : local?.reason && !['scheduled', 'disabled'].includes(local.reason) ? local.reason : null;
  const reason = local?.suspended ? local.reason : !enabled ? policyReason : terminal.has(policyReason) ? policyReason
    : localReason ?? policy?.nativeReason ?? policyReason;
  const paused = enabled && (local?.suspended === true || terminal.has(reason));
  const state = t(paused ? 'Paused' : enabled ? 'Enabled' : 'Disabled');
  const count = value => number(value) ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : t('Unknown');
  const time = value => {
    if (!timestamp(value)) return t('Unknown');
    const formatted = formatTime(value);
    return typeof formatted === 'string' && formatted.trim() ? formatted.replace(/[\r\n]+/g, ' ') : t('Unknown');
  };
  const selectedProvider = provider ?? policy?.provider;
  const nativeTtl = contextMatches ? result.nativeCacheSync?.value ?? result.nativeCache?.value : undefined;
  const ttl = ['5m', '1h'].includes(nativeTtl) ? nativeTtl : ['5m', '1h'].includes(policy?.ttlPreference) ? policy.ttlPreference : t('Unknown');
  const window = selectedProvider === 'codex'
    ? `${t('Interval {minutes} min', { minutes: count(policy?.refreshMinutes) })} · ${t('TTL managed by Codex')}`
    : `TTL ${ttl}`;
  const heading = `${t('Cache warming')}: ${state} · ${window}`;
  const sample = policy?.sample;
  const prefix = number(sample?.cacheReadTokens) && number(sample?.cacheWriteTokens)
    && number(sample.cacheReadTokens + sample.cacheWriteTokens) ? sample.cacheReadTokens + sample.cacheWriteTokens : undefined;
  const tokens = t('Tokens: prefix {prefix} · warm reads: {read}/{readLimit} (counted/limit), output {output}/{outputLimit}', {
    prefix: count(prefix), read: count(policy?.totals?.readTokens), readLimit: policy?.maxReadTokens === null ? t('Unlimited') : count(policy?.maxReadTokens),
    output: count(policy?.totals?.outputTokens), outputLimit: count(policy?.maxOutputTokens),
  });
  const results = policy?.cacheResults;
  const resultTime = value => timestamp(value) ? time(value) : results?.count === 0 || !policy ? t('Not yet') : t('Unknown');
  const history = t('First cache result: {time}', { time: resultTime(results?.firstAt) });
  let next;
  if (local?.suspended || paused || !enabled || (reason && !['scheduled', 'not-due'].includes(reason))) {
    const effectiveReason = !enabled && !local?.suspended && reason === 'scheduled' ? 'disabled' : reason;
    next = reasons[effectiveReason] ? t(reasons[effectiveReason]) : t('Needs inspection');
    if (!reasons[effectiveReason] && /^[a-z][a-z0-9-]{0,63}$/.test(effectiveReason ?? '')) next += ` (${effectiveReason})`;
  } else next = time(policy?.nextAt);
  // Shown only for a policy, so the user sees the limits they chose being used.
  const limits = policy && number(policy.maxRefreshes) ? [t('Limits: {used}/{max} warm requests · until {time}', {
    used: count(policy.totals?.refreshes), max: count(policy.maxRefreshes), time: time(policy.until) })] : [];
  return [heading, tokens, history, t('Next warm: {next}', { next }), ...limits].join('\n');
}
