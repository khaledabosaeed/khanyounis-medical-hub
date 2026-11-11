export function durationSeconds(startedAt, endedAt = new Date()) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = endedAt instanceof Date ? endedAt : new Date(endedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

export function toIsoUtc(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (text.endsWith('Z') || /[+-]\d\d:\d\d$/.test(text)) return new Date(text).toISOString();
  const normalized = text.replace(' ', 'T');
  const withMilliseconds = normalized.includes('.') ? normalized.slice(0, 23) : `${normalized}.000`;
  return `${withMilliseconds}Z`;
}

// Calendar days (archive days, "today's session") use the hub's own time zone
// (Khan Younis), not the server's or the browser's.
export const HUB_TIME_ZONE = (() => {
  const zone = process.env.HUB_TIME_ZONE || 'Asia/Gaza';
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return 'UTC'; }
})();

const hubDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: HUB_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

// YYYY-MM-DD of an instant, in the hub's time zone.
export function hubDay(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? hubDayFormat.format(date) : null;
}

// A study session can be paused (logout) and resumed (login on the same day).
// `duration_seconds` holds the time of the finished stretches and
// `segment_started_at` the start of the stretch that is running now.
// Returns the SQL for the session's study time up to `now`.
export function sessionSecondsSql(alias = 'session', now = 'UTC_TIMESTAMP(3)') {
  const prefix = alias ? `${alias}.` : '';
  return `(CASE WHEN ${prefix}status = 'active'
    THEN ${prefix}duration_seconds + GREATEST(0, TIMESTAMPDIFF(SECOND, COALESCE(${prefix}segment_started_at, ${prefix}started_at), ${now}))
    ELSE ${prefix}duration_seconds END)`;
}

// The instant a running timer would have started from if the session had
// never been paused: lets the browser tick `now - timerStartedAt`.
export function timerStartedAt(session) {
  if (session?.status !== 'active') return null;
  const segment = Date.parse(session.segmentStartedAt || session.startedAt);
  if (!Number.isFinite(segment)) return null;
  return new Date(segment - Number(session.durationSeconds || 0) * 1000).toISOString();
}
