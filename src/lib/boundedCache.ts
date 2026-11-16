export type TimestampedCache<T> = Record<string, T & { ts: number }>;

/** Keep only the newest cache entries so directory caches cannot grow without bound. */
export function setBoundedTimestampCache<T>(
  cache: TimestampedCache<T>,
  key: string,
  value: T & { ts: number },
  limit: number
): TimestampedCache<T> {
  const next = { ...cache, [key]: value };
  if (Object.keys(next).length <= limit) return next;

  return Object.fromEntries(
    Object.entries(next)
      .sort(([, a], [, b]) => b.ts - a.ts)
      .slice(0, limit)
  ) as TimestampedCache<T>;
}
