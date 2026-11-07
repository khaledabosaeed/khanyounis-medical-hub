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
