import {
  getAccessEmail
} from "./chunk-XMM5SQBN.js";
import {
  and,
  drizzle,
  eq
} from "./chunk-ACDUZVLI.js";
import {
  integer,
  sql,
  sqliteTable,
  text
} from "./chunk-VVR3XKHB.js";
import {
  __export
} from "./chunk-MLKGABMK.js";

// src/auth/local.ts
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { admin } from "better-auth/plugins/admin";
import { hashPassword } from "better-auth/crypto";

// ../../node_modules/.pnpm/drizzle-orm@0.45.3_@cloudflare+workers-types@5.20260921.1_kysely@0.29.6/node_modules/drizzle-orm/sql/functions/aggregate.js
function count(expression) {
  return sql`count(${expression || sql.raw("*")})`.mapWith(Number);
}

// src/auth/local-schema.ts
var local_schema_exports = {};
__export(local_schema_exports, {
  account: () => account,
  rateLimit: () => rateLimit,
  session: () => session,
  user: () => user,
  verification: () => verification
});
var user = sqliteTable("galaxy_auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  role: text("role").notNull().default("editor"),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" })
});
var session = sqliteTable("galaxy_auth_session", {
  id: text("id").primaryKey(),
  authMethod: text("auth_method"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by")
});
var account = sqliteTable("galaxy_auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var verification = sqliteTable("galaxy_auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var rateLimit = sqliteTable("galaxy_auth_rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull()
});

// src/auth/local.ts
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
  if (!env.GALAXY_AUTH_SECRET || env.GALAXY_AUTH_SECRET.length < 32) {
    throw new Error("Local CMS authentication requires GALAXY_AUTH_SECRET (at least 32 characters)");
  }
  const origin = new URL(request.url).origin;
  return betterAuth({
    appName: "Talisman CMS",
    baseURL: origin,
    basePath: `${adminPath === "/" ? "" : adminPath}/api/auth`,
    secret: env.GALAXY_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(env.DB, { schema: local_schema_exports }), {
      provider: "sqlite",
      schema: local_schema_exports
    }),
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128
    },
    plugins: [admin({ defaultRole: "editor", adminRoles: ["admin"] })],
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 10 }
      }
    },
    advanced: {
      cookiePrefix: "talisman-cms",
      useSecureCookies: new URL(request.url).protocol === "https:"
    }
  });
}
async function ssoPassword(email, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`talisman-cms-cloudflare-sso:${email}`)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex;
}
async function signInCloudflareAdmin(request, adminPath = "/admin") {
  const env = await getLocalAuthEnv();
  const email = await getAccessEmail(request, env);
  const allowed = new Set((env.GALAXY_ACCESS_ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowed.has(email)) {
    return Response.json({ error: "Cloudflare admin access required" }, { status: 403 });
  }
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const auth = createLocalAuth(request, env, normalizedPath);
  const password = await ssoPassword(email, env.GALAXY_AUTH_SECRET);
  const db = drizzle(env.DB, { schema: local_schema_exports });
  let account2 = await db.query.user.findFirst({ where: sql`lower(${user.email}) = ${email}` });
  if (!account2) {
    try {
      await auth.api.createUser({ body: { email, name: email, password, role: "admin" } });
    } catch {
    }
    account2 = await db.query.user.findFirst({ where: sql`lower(${user.email}) = ${email}` });
  }
  if (!account2 || account2.banned) {
    return Response.json({ error: "Cloudflare admin account is unavailable" }, { status: 403 });
  }
  if (account2.email !== email) {
    await db.update(user).set({ email, updatedAt: /* @__PURE__ */ new Date() }).where(eq(user.id, account2.id));
  }
  const credential = await db.query.account.findFirst({ where: and(eq(account.userId, account2.id), eq(account.providerId, "credential")) });
  const hashed = await hashPassword(password);
  if (credential) {
    await db.update(account).set({ password: hashed, updatedAt: /* @__PURE__ */ new Date() }).where(eq(account.id, credential.id));
  } else {
    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: account2.id,
      providerId: "credential",
      userId: account2.id,
      password: hashed,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    });
  }
  if (account2.role !== "admin") {
    await db.update(user).set({ role: "admin", emailVerified: true, updatedAt: /* @__PURE__ */ new Date() }).where(eq(user.id, account2.id));
  }
  await db.delete(session).where(eq(session.userId, account2.id));
  const url = new URL(`${normalizedPath === "/" ? "" : normalizedPath}/api/auth/sign-in/email`, request.url);
  const signIn = await auth.handler(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(request.url).origin },
    body: JSON.stringify({ email, password })
  }));
  if (!signIn.ok) return Response.json({ error: "Cloudflare admin sign-in failed" }, { status: 503 });
  const signedIn = await signIn.clone().json().catch(() => null);
  if (typeof signedIn?.token !== "string") return Response.json({ error: "Cloudflare admin session failed" }, { status: 503 });
  await db.update(session).set({ authMethod: "cloudflare" }).where(eq(session.token, signedIn.token));
  const issuedSession = await db.query.session.findFirst({ where: eq(session.token, signedIn.token) });
  if (issuedSession?.authMethod !== "cloudflare" || issuedSession.userId !== account2.id) {
    return Response.json({ error: "Cloudflare admin session failed" }, { status: 503 });
  }
  const headers = new Headers({ Location: normalizedPath, "Cache-Control": "no-store" });
  for (const cookie of signIn.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
async function createInitialAdmin(request, env, adminPath, details) {
  const auth = createLocalAuth(request, env, adminPath);
  await auth.api.createUser({ body: { ...details, role: "admin" } });
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
function LocalAuthAdapter(adminPath = "/admin", options = {}) {
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const adapter = {
    async getUser(request) {
      const env = await getLocalAuthEnv();
      const accessEmail = options.requireAccess === false ? void 0 : await getAccessEmail(request, env);
      if (accessEmail === null) return null;
      const auth = createLocalAuth(request, env, normalizedPath);
      const result = await auth.api.getSession({ headers: request.headers });
      const rawUser = result?.user;
      if (!rawUser || rawUser.role !== "admin" && rawUser.role !== "editor") return null;
      if (options.editorOnly && rawUser.role === "admin") {
        const admins = (env.GALAXY_ACCESS_ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase());
        if (!admins.includes(rawUser.email.toLowerCase()) || !result?.session?.id) return null;
        const cmsSession = await drizzle(env.DB, { schema: local_schema_exports }).query.session.findFirst({ where: eq(session.id, result.session.id) });
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
      if (!allowedActions.has(action)) {
        return new Response(null, { status: 404 });
      }
      if (options.editorOnly && action === "change-password") {
        const current = await adapter.getUser(request);
        if (current?.role === "admin") return Response.json({ error: "Admin sign-in is managed through Cloudflare" }, { status: 403 });
      }
      if (action === "sign-in/email") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        if (options.editorOnly) {
          const body = await request.clone().json().catch(() => null);
          if (typeof body?.email === "string") {
            const db = drizzle(env.DB, { schema: local_schema_exports });
            const target = await db.query.user.findFirst({ where: eq(user.email, body.email.trim().toLowerCase()) });
            if (target && target.role !== "editor") {
              return Response.json({ error: "This account does not have editor password access" }, { status: 403 });
            }
          }
        }
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
      }
      if (action === "admin/create-user") {
        const body = await request.clone().json().catch(() => null);
        if (!body || !["admin", "editor"].includes(String(body.role)) || options.editorOnly && body.role !== "editor" || typeof body.password !== "string" || body.password.length < 12 || typeof body.email !== "string") {
          return Response.json({ error: "Choose an admin or editor role and a password of at least 12 characters" }, { status: 400 });
        }
        if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
          return Response.json({ error: "Valid email required" }, { status: 400 });
        }
        const db = drizzle(env.DB, { schema: local_schema_exports });
        const normalizedEmail = body.email.trim().toLowerCase();
        const existing = await db.query.user.findFirst({ where: sql`lower(${user.email}) = ${normalizedEmail}` });
        if (existing) {
          if (existing.role !== "customer" || existing.banned) {
            return Response.json({ error: "This email already has a CMS account" }, { status: 409 });
          }
          const auth2 = createLocalAuth(request, env, normalizedPath);
          if (existing.email !== normalizedEmail) {
            await db.update(user).set({ email: normalizedEmail, updatedAt: /* @__PURE__ */ new Date() }).where(eq(user.id, existing.id));
          }
          await auth2.api.setUserPassword({ body: { userId: existing.id, newPassword: body.password }, headers: request.headers });
          await auth2.api.setRole({ body: { userId: existing.id, role: body.role }, headers: request.headers });
          await auth2.api.revokeUserSessions({ body: { userId: existing.id }, headers: request.headers });
          return Response.json(
            { user: { id: existing.id, email: existing.email, role: body.role } },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
      }
      const resetBody = action === "admin/set-user-password" ? await request.clone().json().catch(() => null) : null;
      if (typeof resetBody?.userId === "string") {
        const db = drizzle(env.DB, { schema: local_schema_exports });
        const target = await db.query.user.findFirst({ where: eq(user.id, resetBody.userId) });
        if (target?.role === "admin" && options.editorOnly) {
          return Response.json({ error: "Cloudflare SSO accounts are managed through Access" }, { status: 403 });
        }
      }
      if (["admin/set-role", "admin/ban-user", "admin/unban-user", "admin/remove-user"].includes(action)) {
        const body = await request.clone().json().catch(() => null);
        if (typeof body?.userId !== "string" || !body.userId || action === "admin/set-role" && !(options.editorOnly ? ["editor", "customer"] : ["admin", "editor"]).includes(String(body.role))) {
          return Response.json({ error: "Choose a valid user and role" }, { status: 400 });
        }
        const actor = await adapter.getUser(request);
        if (!actor || actor.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });
        if (body.userId === actor.id) {
          return Response.json({ error: "You cannot change your own access here" }, { status: 400 });
        }
        const db = drizzle(env.DB, { schema: local_schema_exports });
        const target = await db.query.user.findFirst({ where: eq(user.id, body.userId) });
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
          const [{ total }] = await db.select({ total: count() }).from(user).where(and(eq(user.role, "admin"), eq(user.banned, false)));
          if (total <= 1) {
            return Response.json({ error: "At least one active admin account is required" }, { status: 400 });
          }
        }
      }
      const auth = createLocalAuth(request, env, normalizedPath);
      const response = await auth.handler(request);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      if (action === "sign-in/email" && response.ok) {
        headers.delete("content-length");
        return Response.json({ ok: true }, { status: response.status, headers });
      }
      if (action === "admin/set-user-password" && response.ok) {
        if (typeof resetBody?.userId !== "string") throw new Error("Password reset target missing");
        await auth.api.revokeUserSessions({ body: { userId: resetBody.userId }, headers: request.headers });
      }
      if (action === "admin/set-role" && response.ok) {
        const body = await request.clone().json();
        await auth.api.revokeUserSessions({ body: { userId: body.userId }, headers: request.headers });
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/local",
      exportName: "LocalAuthAdapter",
      type: "factory",
      args: Object.keys(options).length ? [normalizedPath, options] : [normalizedPath]
    },
    enumerable: false,
    configurable: true
  });
  return adapter;
}

export {
  getLocalAuthEnv,
  signInCloudflareAdmin,
  createInitialAdmin,
  LocalAuthAdapter
};
