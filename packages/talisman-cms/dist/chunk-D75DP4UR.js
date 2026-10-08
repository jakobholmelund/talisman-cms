import {
  normalizeIdentityEmail
} from "./chunk-TKMQLVY7.js";
import {
  local_schema_exports,
  session,
  user,
  verification
} from "./chunk-WHOEA75K.js";
import {
  getAccessEmail
} from "./chunk-FEIHHCEJ.js";
import {
  cloudflareAccessSignIn
} from "./chunk-BUMDQFAO.js";
import {
  createDbClient
} from "./chunk-HEG7DNCN.js";
import {
  readSetting
} from "./chunk-GAOPNFAO.js";

// src/auth/local.ts
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { admin } from "better-auth/plugins/admin";
import { drizzle } from "drizzle-orm/d1";
import { and as and2, eq as eq2, count, sql as sql2 } from "drizzle-orm";

// src/auth/profile-actions.ts
import { and, eq, gt, sql } from "drizzle-orm";
var PREFIX = "cms-email-change:";
var actions = /* @__PURE__ */ new Set([
  "admin/get-user-profile",
  "admin/update-user-profile",
  "admin/request-email-change",
  "admin/confirm-email-change",
  "admin/list-user-sessions",
  "admin/revoke-user-session"
]);
var isProfileAction = (action) => actions.has(action);
var fail = (error, status = 400, code) => Response.json({ error, ...code && { code } }, { status });
var digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
var snapshot = (user2) => ({ name: user2.name, email: user2.email, role: user2.role, banned: user2.banned, updatedAt: user2.updatedAt.toISOString() });
var version = (user2) => digest(JSON.stringify(snapshot(user2)));
var unchanged = (user2) => and(
  eq(user.id, user2.id),
  eq(user.email, user2.email),
  eq(user.name, user2.name),
  eq(user.role, user2.role),
  eq(user.banned, user2.banned),
  eq(user.updatedAt, user2.updatedAt)
);
var changedAt = (user2) => new Date(Math.max(Math.floor(Date.now() / 1e3), Math.floor(user2.updatedAt.getTime() / 1e3) + 1) * 1e3);
async function send(env, to, subject, text) {
  const { sendConfiguredEmail } = await import("./email/runtime.js");
  await sendConfiguredEmail(env, { to, subject, text, kind: "cms-email-change" });
}
async function handleProfileAction(action, request, env, actor, options) {
  if (actor.role !== "admin") return fail("Admin access required", 403);
  if (request.method !== "POST") return fail("Method not allowed", 405);
  if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") return fail("JSON body required", 415);
  if (Number(request.headers.get("content-length")) > 16384) return fail("Request body too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16384) return fail("Request body too large", 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("Invalid JSON");
  }
  if (!body || Array.isArray(body) || typeof body.userId !== "string" || !body.userId || body.userId.length > 256) return fail("Choose a valid user");
  const db = createDbClient(env);
  const target = await db.select().from(user).where(eq(user.id, body.userId)).get();
  if (!target) return fail("User not found", 404);
  if (action === "admin/list-user-sessions") {
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1e6) return fail("Invalid session offset");
    const sessions = await db.select({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      authMethod: session.authMethod
    }).from(session).where(and(
      eq(session.userId, target.id),
      gt(session.expiresAt, /* @__PURE__ */ new Date()),
      gt(session.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3))
    )).orderBy(session.id).limit(51).offset(Number(offset));
    return Response.json({
      sessions: sessions.slice(0, 50).map((session2) => ({ ...session2, expiresAt: new Date(Math.min(session2.expiresAt.getTime(), session2.createdAt.getTime() + 7 * 24 * 60 * 60 * 1e3)), current: session2.id === options.currentSessionId })),
      nextOffset: sessions.length > 50 ? Number(offset) + 50 : null
    });
  }
  if (action === "admin/revoke-user-session") {
    if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) return fail("Choose a valid session");
    await db.delete(session).where(and(eq(session.id, body.sessionId), eq(session.userId, target.id)));
    return Response.json({ ok: true, currentSessionEnded: target.id === actor.id && body.sessionId === options.currentSessionId });
  }
  const editable = ["admin", "editor"].includes(target.role) && !(options.editorOnly && target.role === "admin");
  if (action === "admin/get-user-profile") return Response.json({ user: { id: target.id, name: target.name, email: target.email }, version: await version(target), editable });
  if (!editable) return fail("This identity is managed by its sign-in provider or shopper account", 403);
  if (target.banned) return fail("Enable the account before changing its profile", 409);
  if (action !== "admin/confirm-email-change" && (typeof body.version !== "string" || body.version !== await version(target))) return fail("This profile changed. Reload it before saving.", 409, "stale_record");
  if (action === "admin/update-user-profile") {
    if (Object.keys(body).some((key) => !["userId", "version", "name"].includes(key))) return fail("Only the profile name can be changed here");
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(body.name)) return fail("Use a name between 1 and 160 characters");
    const saved = await db.update(user).set({ name: body.name.trim(), updatedAt: changedAt(target) }).where(unchanged(target)).returning();
    if (!saved.length) return fail("This profile changed. Reload it before saving.", 409, "stale_record");
    return Response.json({ ok: true, version: await version(saved[0]) });
  }
  const pendingId = PREFIX + target.id;
  if (action === "admin/request-email-change") {
    if (typeof body.email !== "string") return fail("Valid email required");
    const email = normalizeIdentityEmail(body.email);
    if (!email || email === target.email.toLowerCase()) return fail("Choose a different valid email address");
    if (await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).get()) return fail("That address already has an identity", 409, "conflict");
    const previous = await db.select().from(verification).where(eq(verification.id, pendingId)).get();
    if (previous && previous.createdAt.getTime() > Date.now() - 6e4) return fail("Wait one minute before requesting another code", 429);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const value = JSON.stringify({ actorId: actor.id, userId: target.id, email, original: snapshot(target), codeHash: await digest(code) });
    const now = /* @__PURE__ */ new Date();
    await db.insert(verification).values({ id: pendingId, identifier: pendingId, value, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 15 * 6e4) }).onConflictDoUpdate({ target: verification.id, set: { value, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 15 * 6e4) } });
    try {
      await send(env, email, "Confirm your CMS email change", `An administrator requested a change to your CMS sign-in email. Give them this confirmation code only if you approve the change:

${code}

The code expires in 15 minutes. Ignore this message if you did not approve the change.`);
      await send(env, target.email, "CMS email change requested", "An administrator requested a change to your CMS sign-in email. Your address has not changed. The new address must be confirmed first. Contact your site administrator if you did not approve this request.");
    } catch {
      await db.delete(verification).where(and(eq(verification.id, pendingId), eq(verification.value, value)));
      return fail("Confirmation email could not be sent. The address has not changed.", 503);
    }
    return Response.json({ ok: true, message: "A confirmation code was sent to the new address. The current address was notified." });
  }
  if (action === "admin/confirm-email-change") {
    if (typeof body.code !== "string" || !/^[a-f0-9]{48}$/.test(body.code.trim())) return fail("Enter the confirmation code from the new address");
    const pending = await db.select().from(verification).where(and(eq(verification.id, pendingId), gt(verification.expiresAt, /* @__PURE__ */ new Date()))).get();
    if (!pending) return fail("This code expired or was already used");
    let value;
    try {
      value = JSON.parse(pending.value);
    } catch {
      return fail("This email change is no longer valid");
    }
    if (value.actorId !== actor.id || value.codeHash !== await digest(body.code.trim())) return fail("Invalid confirmation code");
    if (JSON.stringify(value.original) !== JSON.stringify(snapshot(target))) return fail("This profile changed. Request a new code.", 409, "stale_record");
    const pendingCondition = sql`EXISTS (SELECT 1 FROM ${verification} WHERE ${verification.id} = ${pendingId}
      AND ${verification.value} = ${pending.value} AND ${verification.expiresAt} > ${Math.floor(Date.now() / 1e3)})`;
    const condition = sql`${pendingCondition} AND EXISTS (SELECT 1 FROM ${user} WHERE ${unchanged(target)})`;
    let statements = [];
    try {
      const { identityEmailChangeHooks } = await import("virtual:talisman-cms/identity-email-change");
      for (const hook of identityEmailChangeHooks) statements.push(...await hook(env, { userId: target.id, oldEmail: target.email, newEmail: value.email, condition }));
      const queries = [
        ...statements.map((statement) => db.run(statement)),
        db.delete(session).where(and(eq(session.userId, target.id), condition)),
        db.update(user).set({ email: value.email, emailVerified: true, updatedAt: changedAt(target) }).where(and(eq(user.id, target.id), condition)).returning({ id: user.id }),
        db.delete(verification).where(and(eq(verification.id, pendingId), pendingCondition))
      ];
      const result = await db.batch(queries);
      if (!result[statements.length + 1].length) return fail("This profile changed. Request a new code.", 409, "stale_record");
    } catch {
      console.error("[talisman-cms] Email change batch failed");
      return fail("The email change could not be confirmed. Reload the profile before retrying; linked accounts may need review.", 409, "conflict");
    }
    return Response.json({ ok: true, currentSessionEnded: actor.id === target.id, message: "Email changed. Existing CMS and linked shopper sessions were ended." });
  }
  return fail("Unknown action", 404);
}

// src/auth/local.ts
var MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
async function getLocalAuthEnv() {
  try {
    const worker = await import("cloudflare:workers");
    return worker.env;
  } catch {
    return process.env;
  }
}
function createLocalAuth(request, env, adminPath = "/admin") {
  if (!env.DB) throw new Error("Local CMS authentication requires the DB binding");
  const secret = readSetting(env, "AUTH_SECRET");
  if (!secret || secret.length < 32) {
    throw new Error("Local CMS authentication requires TALISMAN_AUTH_SECRET (at least 32 characters)");
  }
  const origin = new URL(request.url).origin;
  return betterAuth({
    appName: "Talisman CMS",
    baseURL: origin,
    basePath: `${adminPath === "/" ? "" : adminPath}/api/auth`,
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(env.DB), {
      provider: "sqlite",
      schema: local_schema_exports
    }),
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      // How the session was issued: `cloudflare` for an Access sign-in. Set at creation, never by a client.
      additionalFields: { authMethod: { type: "string", required: false, input: false } }
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128
    },
    plugins: [
      // A user created without a role is a shopper: the table holds shopper identities too, and only an
      // explicit admin or editor role grants CMS access.
      admin({ defaultRole: "customer", adminRoles: ["admin"] }),
      cloudflareAccessSignIn({
        verify: (headers) => getAccessEmail(new Request(origin, { headers }), env),
        allowed: () => allowlistedAdmins(env),
        maxSessionAgeMs: MAX_SESSION_AGE_MS
      })
    ],
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 10 }
      }
    },
    advanced: {
      cookiePrefix: "talisman-cms",
      useSecureCookies: new URL(request.url).protocol === "https:",
      // Cloudflare sets CF-Connecting-IP itself; X-Forwarded-For is client-controlled there,
      // and an unresolvable IP would put every sign-in into one shared rate-limit bucket.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }
    }
  });
}
function allowlistedAdmins(env) {
  return new Set((readSetting(env, "ACCESS_ADMIN_EMAILS") || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}
async function signInCloudflareAdmin(request, adminPath = "/admin") {
  const env = await getLocalAuthEnv();
  const email = await getAccessEmail(request, env);
  if (!email || !allowlistedAdmins(env).has(email)) {
    return Response.json({ error: "Cloudflare admin access required" }, { status: 403 });
  }
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const auth = createLocalAuth(request, env, normalizedPath);
  const forwarded = new Headers();
  for (const name of ["cf-access-jwt-assertion", "cf-connecting-ip", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  let signIn;
  try {
    signIn = await auth.api.signInCloudflareAccess({ headers: forwarded, asResponse: true });
  } catch (error) {
    console.error("[talisman-cms] Cloudflare admin sign-in failed", error);
    return Response.json({ error: "Cloudflare admin sign-in failed" }, { status: 503 });
  }
  if (signIn.status === 403) {
    const body = await signIn.json().catch(() => null);
    return Response.json({ error: typeof body?.message === "string" ? body.message : "Cloudflare admin access required" }, { status: 403 });
  }
  if (!signIn.ok) return Response.json({ error: "Cloudflare admin sign-in failed" }, { status: 503 });
  const headers = new Headers({ Location: normalizedPath, "Cache-Control": "no-store" });
  for (const cookie of signIn.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
async function createInitialAdmin(request, env, adminPath, details) {
  const auth = createLocalAuth(request, env, adminPath);
  await auth.api.createUser({ body: { ...details, role: "admin" } });
}
function invalidCredentials() {
  return Response.json(
    { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
    { status: 401, statusText: "UNAUTHORIZED", headers: { "Cache-Control": "no-store" } }
  );
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
var SESSIONS_NOT_ENDED = "The change was saved, but existing sessions for this account could not be ended. Repeat the action to end them.";
var DISABLED_SESSIONS_NOT_ENDED = "The account was disabled, but its existing sessions could not be ended. They cannot open the CMS while the account is disabled, and they are ended before it is enabled again.";
var REVOKED_SESSIONS_NOT_ENDED = "CMS access was revoked, but existing sessions for this account could not be ended. They cannot open the CMS without CMS access, and they are ended before access is granted again.";
var GRANT_NOT_SAVED = "Existing sessions for this account could not be ended, so nothing was changed. Try again.";
async function revokeSessionsAfterChange(auth, userId, headers, warning = SESSIONS_NOT_ENDED) {
  try {
    await auth.api.revokeUserSessions({ body: { userId }, headers });
    return void 0;
  } catch (error) {
    console.error("[talisman-cms] Could not end CMS sessions after an account change", error);
    return warning;
  }
}
async function endSessionsBeforeGrant(auth, userId, headers) {
  try {
    await auth.api.revokeUserSessions({ body: { userId }, headers });
    return void 0;
  } catch (error) {
    console.error("[talisman-cms] Could not end CMS sessions before restoring CMS access", error);
    return Response.json({ error: GRANT_NOT_SAVED }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
function LocalAuthAdapter(adminPath, options = {}) {
  const normalizedPath = normalizeAuthAdminPath(adminPath);
  const adapter = {
    async getUser(request) {
      const env = await getLocalAuthEnv();
      const accessEmail = options.requireAccess === false ? void 0 : await getAccessEmail(request, env);
      if (accessEmail === null) return null;
      const auth = createLocalAuth(request, env, normalizedPath);
      const result = await auth.api.getSession({ headers: request.headers });
      const rawUser = result?.user;
      if (!result || !rawUser) return null;
      if (!(Date.now() - new Date(result.session.createdAt).getTime() <= MAX_SESSION_AGE_MS)) {
        await drizzle(env.DB).delete(session).where(eq2(session.id, result.session.id));
        return null;
      }
      if (rawUser.banned && !(rawUser.banExpires && new Date(rawUser.banExpires).getTime() < Date.now())) return null;
      if (rawUser.role !== "admin" && rawUser.role !== "editor") return null;
      if (options.editorOnly && rawUser.role === "admin") {
        if (!allowlistedAdmins(env).has(rawUser.email.toLowerCase()) || !result?.session?.id) return null;
        const cmsSession = await drizzle(env.DB).select().from(session).where(eq2(session.id, result.session.id)).get();
        if (cmsSession?.authMethod !== "cloudflare") return null;
      }
      if (accessEmail !== void 0 && accessEmail !== rawUser.email.toLowerCase()) return null;
      return {
        id: rawUser.id,
        email: rawUser.email,
        name: rawUser.name,
        avatarUrl: rawUser.image ?? void 0,
        role: rawUser.role
      };
    },
    async signIn(request) {
      return Response.redirect(new URL(normalizedPath, request.url));
    },
    async signOut(request) {
      const url = new URL(`${normalizedPath === "/" ? "" : normalizedPath}/api/auth/sign-out`, request.url);
      const headers = new Headers(request.headers);
      headers.set("Content-Type", "application/json");
      return adapter.handle(new Request(url, { method: "POST", headers, body: "{}" }));
    },
    async handle(request) {
      if (!sameOrigin(request)) return Response.json({ error: "Cross-origin auth request rejected" }, { status: 403 });
      const env = await getLocalAuthEnv();
      const accessEmail = options.requireAccess === false ? void 0 : await getAccessEmail(request, env);
      if (accessEmail === null) return Response.json({ error: "Cloudflare Access authorization required" }, { status: 403 });
      const basePath = `${normalizedPath === "/" ? "" : normalizedPath}/api/auth/`;
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath)) return new Response(null, { status: 404 });
      const action = path.slice(basePath.length);
      const allowedActions = /* @__PURE__ */ new Set([
        "sign-in/email",
        "sign-out",
        "change-password",
        "admin/list-users",
        "admin/create-user",
        "admin/set-user-password",
        "admin/set-role",
        "admin/ban-user",
        "admin/unban-user",
        "admin/remove-user"
      ]);
      if (!allowedActions.has(action) && !isProfileAction(action)) {
        return new Response(null, { status: 404 });
      }
      if (options.editorOnly && action === "change-password") {
        const current = await adapter.getUser(request);
        if (current?.role === "admin") return Response.json({ error: "Admin sign-in is managed through Cloudflare" }, { status: 403 });
      }
      if (action === "sign-in/email") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        if (accessEmail !== void 0) {
          const body = await request.clone().json().catch(() => null);
          if (typeof body?.email !== "string" || body.email.toLowerCase() !== accessEmail) {
            return Response.json({ error: "Account must match Cloudflare Access identity" }, { status: 403 });
          }
        }
      } else {
        const user2 = await adapter.getUser(request);
        if (!user2) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (action.startsWith("admin/") && user2.role !== "admin") {
          return Response.json({ error: "Admin access required" }, { status: 403 });
        }
        if (isProfileAction(action)) {
          const current = await createLocalAuth(request, env, normalizedPath).api.getSession({ headers: request.headers });
          let response2;
          try {
            response2 = await handleProfileAction(action, request, env, user2, { editorOnly: options.editorOnly, currentSessionId: current?.session.id });
          } catch {
            console.error("[talisman-cms] Profile action failed");
            response2 = Response.json({ error: "The request could not be completed. Reload the profile before retrying." }, { status: 503 });
          }
          const headers2 = new Headers(response2.headers);
          headers2.set("Cache-Control", "no-store");
          return new Response(response2.body, { status: response2.status, headers: headers2 });
        }
      }
      if (action === "admin/create-user") {
        const body = await request.clone().json().catch(() => null);
        if (!body || typeof body.role !== "string" || !["admin", "editor"].includes(body.role) || options.editorOnly && body.role !== "editor" || typeof body.password !== "string" || body.password.length < 12 || typeof body.email !== "string") {
          return Response.json({ error: "Choose an admin or editor role and a password of at least 12 characters" }, { status: 400 });
        }
        if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
          return Response.json({ error: "Valid email required" }, { status: 400 });
        }
        const db = drizzle(env.DB);
        const normalizedEmail = body.email.trim().toLowerCase();
        const existing = await db.select().from(user).where(sql2`lower(${user.email}) = ${normalizedEmail}`).get();
        if (existing) {
          if (existing.role !== "customer") {
            return Response.json({ error: "This email already has a CMS account", code: "conflict" }, { status: 409 });
          }
          if (existing.banned) {
            return Response.json({ error: "This account is disabled. Enable it in the user list before granting CMS access.", code: "conflict" }, { status: 409 });
          }
          const auth2 = createLocalAuth(request, env, normalizedPath);
          const notGranted = await endSessionsBeforeGrant(auth2, existing.id, request.headers);
          if (notGranted) return notGranted;
          if (existing.email !== normalizedEmail) {
            await db.update(user).set({ email: normalizedEmail, updatedAt: /* @__PURE__ */ new Date() }).where(eq2(user.id, existing.id));
          }
          await auth2.api.setUserPassword({ body: { userId: existing.id, newPassword: body.password }, headers: request.headers });
          await auth2.api.setRole({ body: { userId: existing.id, role: body.role }, headers: request.headers });
          return Response.json(
            { user: { id: existing.id, email: existing.email, role: body.role } },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
      }
      let revokeUserId;
      let revokeWarning = SESSIONS_NOT_ENDED;
      let banUserId;
      const resetBody = action === "admin/set-user-password" ? await request.clone().json().catch(() => null) : null;
      if (action === "admin/set-user-password") {
        if (typeof resetBody?.userId !== "string" || !resetBody.userId) {
          return Response.json({ error: "Choose a valid user" }, { status: 400 });
        }
        revokeUserId = resetBody.userId;
        const db = drizzle(env.DB);
        const target = await db.select().from(user).where(eq2(user.id, resetBody.userId)).get();
        if (target?.role === "admin" && options.editorOnly) {
          return Response.json({ error: "Cloudflare SSO accounts are managed through Access" }, { status: 403 });
        }
      }
      if (["admin/set-role", "admin/ban-user", "admin/unban-user", "admin/remove-user"].includes(action)) {
        const body = await request.clone().json().catch(() => null);
        if (typeof body?.userId !== "string" || !body.userId || action === "admin/set-role" && (typeof body.role !== "string" || !(options.editorOnly ? ["editor", "customer"] : ["admin", "editor"]).includes(body.role))) {
          return Response.json({ error: "Choose a valid user and role" }, { status: 400 });
        }
        const actor = await adapter.getUser(request);
        if (!actor || actor.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });
        if (body.userId === actor.id) {
          return Response.json({ error: "You cannot change your own access here" }, { status: 400 });
        }
        const db = drizzle(env.DB);
        const target = await db.select().from(user).where(eq2(user.id, body.userId)).get();
        if (target?.role === "admin" && options.editorOnly) {
          return Response.json({ error: "Cloudflare SSO accounts are managed through Access" }, { status: 403 });
        }
        if (options.editorOnly && action === "admin/set-role" && target?.role === "customer" && body.role === "editor") {
          return Response.json({ error: "Grant editor access by setting a password in Add editor" }, { status: 400 });
        }
        if (options.editorOnly && action === "admin/remove-user") {
          return Response.json({ error: "Use Revoke CMS access to retain the shared shopper identity" }, { status: 400 });
        }
        if (target?.role === "admin" && !target.banned && (action === "admin/ban-user" || action === "admin/remove-user" || action === "admin/set-role" && body.role !== "admin")) {
          const [{ total }] = await db.select({ total: count() }).from(user).where(and2(eq2(user.role, "admin"), eq2(user.banned, false)));
          if (total <= 1) {
            return Response.json({ error: "At least one active admin account is required" }, { status: 400 });
          }
        }
        const grantsAccess = target && (action === "admin/unban-user" && target.banned || action === "admin/set-role" && !["admin", "editor"].includes(target.role ?? "") && body.role !== "customer");
        if (grantsAccess) {
          const notGranted = await endSessionsBeforeGrant(createLocalAuth(request, env, normalizedPath), body.userId, request.headers);
          if (notGranted) return notGranted;
        }
        if (action === "admin/set-role") {
          revokeUserId = body.userId;
          if (body.role === "customer") revokeWarning = REVOKED_SESSIONS_NOT_ENDED;
        }
        if (action === "admin/ban-user") banUserId = body.userId;
      }
      const auth = createLocalAuth(request, env, normalizedPath);
      const response = await auth.handler(request);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      if (action === "sign-in/email" && response.status >= 400 && response.status < 500 && response.status !== 429) {
        return invalidCredentials();
      }
      if (action === "sign-in/email" && response.ok) {
        const signedIn = await response.clone().json().catch(() => null);
        const db = drizzle(env.DB);
        const [issued] = typeof signedIn?.token === "string" ? await db.select({ role: user.role }).from(session).innerJoin(user, eq2(user.id, session.userId)).where(eq2(session.token, signedIn.token)).limit(1) : [];
        if (!issued || !(options.editorOnly ? ["editor"] : ["admin", "editor"]).includes(issued.role)) {
          if (typeof signedIn?.token === "string") await db.delete(session).where(eq2(session.token, signedIn.token));
          return invalidCredentials();
        }
        headers.delete("content-length");
        return Response.json({ ok: true }, { status: response.status, headers });
      }
      if (revokeUserId && response.ok) {
        const warning = await revokeSessionsAfterChange(auth, revokeUserId, request.headers, revokeWarning);
        if (warning) {
          const payload = await response.json().catch(() => ({}));
          headers.delete("content-length");
          return Response.json({ ...payload, warning }, { status: response.status, headers });
        }
      }
      if (banUserId && response.status >= 500) {
        const target = await drizzle(env.DB).select().from(user).where(eq2(user.id, banUserId)).get();
        if (target?.banned) {
          console.error("[talisman-cms] Could not end CMS sessions after disabling an account");
          headers.delete("content-length");
          headers.set("Content-Type", "application/json");
          return Response.json({ user: target, warning: DISABLED_SESSIONS_NOT_ENDED }, { status: 200, headers });
        }
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/local",
      exportName: "LocalAuthAdapter",
      type: "factory",
      args: Object.keys(options).length ? [options] : [],
      adminPath: true,
      ...adminPath === void 0 ? {} : { configuredAdminPath: normalizedPath }
    },
    enumerable: false,
    configurable: true
  });
  return adapter;
}
function normalizeAuthAdminPath(adminPath) {
  const trimmed = adminPath?.trim();
  if (!trimmed) return "/admin";
  if (trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export {
  getLocalAuthEnv,
  signInCloudflareAdmin,
  createInitialAdmin,
  LocalAuthAdapter,
  normalizeAuthAdminPath
};
