/** Isolate-local, bounded best-effort protection; never a distributed quota. */
const ids = new WeakMap<object, number>();
let nextId = 0;
export function bindingId(value: unknown) {
  if (!value || typeof value !== 'object') return 'missing';
  if (!ids.has(value)) ids.set(value, ++nextId);
  return ids.get(value);
}
export function scopeKey(env: Record<string, unknown>, adminBase: string) {
  return JSON.stringify([bindingId(env.DB), bindingId(env.AI), adminBase,
    env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID, env.CLOUDFLARE_ANALYTICS_SITE_TAG,
    env.CLOUDFLARE_ANALYTICS_API_TOKEN, env.TALISMAN_COMMERCE_STRIPE_MODE, env.GALAXY_COMMERCE_STRIPE_MODE]);
}
export function privateJson(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', ...extra } });
}
export function reportCache<T>() {
  const entries = new Map<string, { expires: number; promise: Promise<T> }>();
  return (key: string, read: () => Promise<T>, cacheable: (value: T) => boolean = () => true) => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
    const cached = entries.get(key);
    if (cached) return cached.promise;
    if (entries.size >= 100) entries.delete(entries.keys().next().value!);
    const entry = { expires: now + 120_000, promise: Promise.resolve().then(read) };
    entries.set(key, entry);
    entry.promise = entry.promise.then(value => {
      if (!cacheable(value) && entries.get(key) === entry) entries.delete(key);
      return value;
    }, error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry.promise;
  };
}
const users = new Map<string, { until: number; count: number }>();
export function allowQuestion(key: string) {
  const now = Date.now();
  for (const [key, item] of users) if (item.until <= now) users.delete(key);
  const item = users.get(key);
  if (item) { if (item.count >= 5) return false; item.count++; return true; }
  // Refuse rather than evict active users and reset their quotas.
  if (users.size >= 1000) return false;
  users.set(key, { until: now + 60_000, count: 1 });
  return true;
}
export async function questionBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw privateJson({ error: 'Expected a JSON request.' }, 415);
  }
  if (Number(request.headers.get('Content-Length')) > 1024) throw privateJson({ error: 'Question is too long.' }, 413);
  const reader = request.body?.getReader();
  if (!reader) throw privateJson({ error: 'Expected a JSON object.' }, 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); throw privateJson({ error: 'Question is too long.' }, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw privateJson({ error: 'Expected a JSON object.' }, 400); }
}
