// Read-only presentation and limit parsing shared by native local commands. No scheduling or inference.
export const WARM_LIMIT_HELP = 'one of rounds=N (1-500), for=90m|3h|1h30m (up to 168h) or until=HH:MM|DD:HH:MM (local 24-hour time, within 168h)';
const WARM_MAX_HOURS = 168, WARM_MAX_MINUTES = WARM_MAX_HOURS * 60, WARM_MAX_ROUNDS = 500, WARM_DEFAULT_MINUTES = 240;

/** Turn the user's one chosen limit into the existing maxMinutes/maxRefreshes
 * bounds. rounds is a number of warm requests, for a duration, until a local
 * HH:MM or day-of-month DD:HH:MM. A time limit allows the requests that fit in
 * it; rounds must fit in 168 hours. With no limit the command warms for four
 * hours, as for=4h. Returns the remaining words and the bounds. */
export function parseWarmLimits(words, { intervalMinutes, now }) {
  const rest = [], seen = new Map();
  for (const word of words) {
    const match = /^(rounds|for|until)=(.*)$/.exec(word);
    if (!match) { rest.push(word); continue; }
    if (seen.size) throw new Error(`Choose only one limit: ${WARM_LIMIT_HELP}.`);
    seen.set(match[1], match[2]);
  }
  const invalid = () => new Error(`Limits: ${WARM_LIMIT_HELP}.`);
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || !Number.isFinite(now)) throw invalid();
  if (seen.has('rounds')) {
    const rounds = /^[1-9][0-9]{0,2}$/.test(seen.get('rounds')) ? Number(seen.get('rounds')) : 0;
    if (rounds < 1 || rounds > WARM_MAX_ROUNDS) throw invalid();
    const fitting = Math.floor(WARM_MAX_MINUTES / intervalMinutes);
    if (rounds > fitting)
      throw new Error(`${rounds} warm requests cannot fit in ${WARM_MAX_HOURS} hours at one every ${intervalMinutes} min; the most is ${fitting}.`);
    return { rest, bounds: { maxMinutes: WARM_MAX_MINUTES, maxRefreshes: rounds } };
  }
  let minutes = WARM_DEFAULT_MINUTES;
  if (seen.has('for')) {
    const duration = /^(?:([0-9]{1,3})h)?(?:([0-9]{1,5})m)?$/.exec(seen.get('for'));
    if (!duration || duration[1] === undefined && duration[2] === undefined) throw invalid();
    minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0);
  } else if (seen.has('until')) {
    const clock = /^(?:(0?[1-9]|[12][0-9]|3[01]):)?([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(seen.get('until'));
    if (!clock) throw invalid();
    const start = new Date(now), day = clock[1] === undefined ? null : Number(clock[1]);
    let target = null;
    // The next occurrence: today or tomorrow for a time, this month or a
    // following one for a day of the month. A month without that day is skipped.
    for (let step = 0; step < 4 && !target; step++) {
      const candidate = day === null
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + step, Number(clock[2]), Number(clock[3]))
        : new Date(start.getFullYear(), start.getMonth() + step, day, Number(clock[2]), Number(clock[3]));
      if ((day === null || candidate.getDate() === day) && candidate.getTime() > now) target = candidate;
    }
    if (!target) throw invalid();
    minutes = Math.ceil((target.getTime() - now) / 60000);
    if (minutes > WARM_MAX_MINUTES) throw new Error(`until=${seen.get('until')} is more than ${WARM_MAX_HOURS} hours away.`);
  }
  if (minutes < 1 || minutes > WARM_MAX_MINUTES) throw invalid();
  const fixedEnd = seen.has('until') ? { fixedEnd: true } : {};
  if (minutes < intervalMinutes)
    throw new Error(`No warm request fits in ${minutes} min: the first one is due ${intervalMinutes} min after a reply.`);
  const fitting = Math.floor(minutes / intervalMinutes);
  if (fitting > WARM_MAX_ROUNDS)
    throw new Error(`${minutes} min would take ${fitting} warm requests; the limit is ${WARM_MAX_ROUNDS} (${WARM_MAX_ROUNDS * intervalMinutes} min at this interval).`);
  return { rest, bounds: { maxMinutes: minutes, maxRefreshes: fitting, ...fixedEnd } };
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
  'user-message': 'Stopped by your message',
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
const terminal = new Set(['duration-limit', 'refresh-limit', 'user-message', 'read-budget', 'output-budget', 'actual-budget-exceeded',
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

export const DEFAULT_WARM_LIMIT = 'for=4h';

/** The limit /claudex:warm on uses when it is given none. Whether it fits the
 * refresh interval is decided when warming is enabled; here it must be valid
 * for at least one TTL and may not name a day of the month. */
export function defaultWarmLimit(value, now = Date.now()) {
  if (value === undefined || value === null) return DEFAULT_WARM_LIMIT;
  const limit = value;
  if (typeof limit !== 'string' || limit.length > 32 || /^until=[^:]*:[^:]*:/.test(limit)) throw new Error(`Default warming limit must be ${WARM_LIMIT_HELP}, without a day of the month.`);
  let failure;
  for (const intervalMinutes of [55, 4]) {
    try { if (!parseWarmLimits([limit], { intervalMinutes, now }).rest.length) return limit; }
    catch (error) { failure = error; }
  }
  throw failure ?? new Error(`Default warming limit must be ${WARM_LIMIT_HELP}.`);
}
