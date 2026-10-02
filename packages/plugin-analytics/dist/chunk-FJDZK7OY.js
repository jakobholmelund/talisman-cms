// src/routes/support.ts
var ids = /* @__PURE__ */ new WeakMap();
var nextId = 0;
function bindingId(value) {
  if (!value || typeof value !== "object") return "missing";
  if (!ids.has(value)) ids.set(value, ++nextId);
  return ids.get(value);
}
function scopeKey(env, adminBase) {
  return JSON.stringify([
    bindingId(env.DB),
    bindingId(env.AI),
    adminBase,
    env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID,
    env.CLOUDFLARE_ANALYTICS_SITE_TAG,
    env.CLOUDFLARE_ANALYTICS_API_TOKEN,
    env.TALISMAN_COMMERCE_STRIPE_MODE,
    env.GALAXY_COMMERCE_STRIPE_MODE
  ]);
}
function privateJson(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", ...extra } });
}
function reportCache() {
  const entries = /* @__PURE__ */ new Map();
  return (key, read, cacheable = () => true) => {
    const now = Date.now();
    for (const [key2, entry2] of entries) if (entry2.expires <= now) entries.delete(key2);
    const cached = entries.get(key);
    if (cached) return cached.promise;
    if (entries.size >= 100) entries.delete(entries.keys().next().value);
    const entry = { expires: now + 12e4, promise: Promise.resolve().then(read) };
    entries.set(key, entry);
    entry.promise = entry.promise.then((value) => {
      if (!cacheable(value) && entries.get(key) === entry) entries.delete(key);
      return value;
    }, (error) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry.promise;
  };
}
var users = /* @__PURE__ */ new Map();
function allowQuestion(key) {
  const now = Date.now();
  for (const [key2, item2] of users) if (item2.until <= now) users.delete(key2);
  const item = users.get(key);
  if (item) {
    if (item.count >= 5) return false;
    item.count++;
    return true;
  }
  if (users.size >= 1e3) return false;
  users.set(key, { until: now + 6e4, count: 1 });
  return true;
}
async function questionBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
    throw privateJson({ error: "Expected a JSON request." }, 415);
  }
  if (Number(request.headers.get("Content-Length")) > 1024) throw privateJson({ error: "Question is too long." }, 413);
  const reader = request.body?.getReader();
  if (!reader) throw privateJson({ error: "Expected a JSON object." }, 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        throw privateJson({ error: "Question is too long." }, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw privateJson({ error: "Expected a JSON object." }, 400);
  }
}

export {
  scopeKey,
  privateJson,
  reportCache,
  allowQuestion,
  questionBody
};
