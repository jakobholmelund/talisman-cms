import type { TalismanEnv } from 'talisman-cms/client';

/**
 * Request counters for shopper-facing routes. Every counter is a row in `_ecommerce_rate_limits`
 * (key, count, window_start) with a fixed window that starts with its first request.
 *
 * - Keys that carry client data (addresses, codes, IPs) hold only a SHA-256 hex digest of it.
 * - Windows are at most 24 hours: the retention purge deletes rows whose window started more than
 *   a day ago, so a longer window would silently restart.
 */

/** The longest window a counter may use; see the retention purge in api.ts. */
export const MAX_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

/** Lowercase hex SHA-256 of `value`. */
export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The unit one client is limited by: an IPv4 address, or the /64 prefix of an IPv6 address, since an
 * IPv6 client can usually use any address in its /64. IPv4-mapped IPv6 counts as the IPv4 address.
 * A value that does not parse is returned trimmed and lowercased.
 */
export function rateLimitSource(ip: string) {
  const value = ip.trim().toLowerCase();
  if (!value.includes(':')) return value;
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const halves = value.split('::');
  if (halves.length > 2) return value;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 address fills the last two groups.
  const width = [...left, ...right].reduce((count, group) => count + (group.includes('.') ? 2 : 1), 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return value;
  const groups = [...left, ...Array<string>(8 - width).fill('0'), ...right].slice(0, 4);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

/**
 * Counts one request for `key` and returns the new count in the current window, or undefined if the
 * database returned no row (callers treat that as over the limit). `now` is in Unix seconds. The
 * counters live in `_ecommerce_rate_limits`: better-auth prunes its own table by its own clock,
 * which deleted these counters when they were kept there.
 */
export async function countRequest(env: TalismanEnv, key: string, now: number, windowSeconds: number) {
  if (!(windowSeconds > 0 && windowSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError('Rate-limit windows must be between 1 second and 24 hours');
  }
  const limit = await env.DB.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
    VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING count`)
    .bind(key, now, now - windowSeconds, now - windowSeconds, now)
    .first<{ count: number }>();
  return limit?.count;
}

/**
 * The count in `key`'s current window without counting a request; 0 when the window has ended or the
 * key was never used.
 */
export async function peekRequestCount(env: TalismanEnv, key: string, now: number, windowSeconds: number) {
  const row = await env.DB.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = ? AND window_start > ?`)
    .bind(key, now - windowSeconds).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Counts a request from `sourceIp` in `bucket` and says whether that client is over `limit` requests
 * per `windowSeconds`. The key is `bucket:` plus the hashed `rateLimitSource(sourceIp)`. Returns false
 * without counting when there is no usable client IP (missing or longer than 64 characters), so
 * callers that must hold without one need their own store-wide limit.
 */
export async function clientOverLimit(env: TalismanEnv, bucket: string, sourceIp: string | null | undefined,
  { limit, windowSeconds, now = Math.floor(Date.now() / 1000) }: { limit: number; windowSeconds: number; now?: number }) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count = await countRequest(env, `${bucket}:${await sha256Hex(rateLimitSource(sourceIp))}`, now, windowSeconds);
  return (count ?? limit + 1) > limit;
}
