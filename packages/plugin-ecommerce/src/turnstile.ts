import type { TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';

/** The widget action the shopper sign-in form sets; siteverify must report the same one. */
export const SHOPPER_SIGN_IN_TURNSTILE_ACTION = 'shopper-sign-in';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Siteverify is on the sign-in path, so a slow answer fails closed instead of holding the request. */
const SITEVERIFY_TIMEOUT_MS = 5000;
/** Cloudflare's documented maximum token length. */
const MAX_TOKEN_LENGTH = 2048;
/**
 * Cloudflare's published test secret keys. Their answers name a placeholder hostname and action, so
 * those two comparisons are skipped for them. A test key never protects a live site, so it is only
 * accepted on a local development host.
 */
const TEST_SECRET_KEY = /^[123]x0{31}AA$/;

/** localhost, 127.0.0.1, [::1], or a name ending in .localhost or .test. */
function isLocalDevelopmentHost(hostname: string) {
  const host = hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost') || host.endsWith('.test');
}

export type TurnstileRefusal = 'missing_token' | 'rejected' | 'unavailable' | 'hostname_mismatch' | 'action_mismatch' | 'test_key';

/** The configured widget keys (blank counts as unset). The secret alone turns the server-side check on. */
export function readTurnstileSettings(env: TalismanEnv) {
  return {
    siteKey: readSetting(env, 'COMMERCE_TURNSTILE_SITE_KEY') ?? null,
    secretKey: readSetting(env, 'COMMERCE_TURNSTILE_SECRET_KEY') ?? null,
  };
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify endpoint. Only `success: true` passes, and
 * only when a reported hostname equals `expectedHostname` and a reported action equals
 * `expectedAction`. A network error, a timeout or an answer that is not the expected JSON fails
 * closed, and a Cloudflare test secret is refused unless `expectedHostname` is a local development host. `refusal` is null when the token passes, otherwise a code; `errorCodes` are Cloudflare's.
 * Both are safe to log.
 */
export async function verifyTurnstileToken(secretKey: string, token: unknown, {
  remoteIp, expectedHostname, expectedAction,
}: { remoteIp?: string | null; expectedHostname: string; expectedAction: string }): Promise<{ refusal: TurnstileRefusal | null; errorCodes: string[] }> {
  const testKey = TEST_SECRET_KEY.test(secretKey);
  if (testKey && !isLocalDevelopmentHost(expectedHostname)) return { refusal: 'test_key', errorCodes: [] };
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return { refusal: 'missing_token', errorCodes: [] };
  let answer: { success?: unknown; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secretKey, response: token, ...(remoteIp && remoteIp.length <= 64 ? { remoteip: remoteIp } : {}) }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return { refusal: 'unavailable', errorCodes: [`http_${response.status}`] };
    answer = await response.json() as typeof answer;
    if (!answer || typeof answer !== 'object') return { refusal: 'unavailable', errorCodes: [] };
  } catch {
    return { refusal: 'unavailable', errorCodes: [] };
  }
  // Cloudflare's codes, such as `invalid-input-response`, carry no visitor data.
  const errorCodes = Array.isArray(answer['error-codes'])
    ? answer['error-codes'].filter((code): code is string => typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)).slice(0, 5)
    : [];
  if (answer.success !== true) return { refusal: 'rejected', errorCodes };
  if (!testKey) {
    if (typeof answer.hostname === 'string' && answer.hostname && answer.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      return { refusal: 'hostname_mismatch', errorCodes };
    }
    if (typeof answer.action === 'string' && answer.action !== expectedAction) return { refusal: 'action_mismatch', errorCodes };
  }
  return { refusal: null, errorCodes };
}
