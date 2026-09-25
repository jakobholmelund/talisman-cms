import {
  getAccessEmail
} from "../chunk-XMM5SQBN.js";
import {
  drizzle
} from "../chunk-ACDUZVLI.js";
import {
  integer,
  sqliteTable,
  text
} from "../chunk-VVR3XKHB.js";
import {
  __export
} from "../chunk-MLKGABMK.js";

// src/auth/local.ts
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { admin } from "better-auth/plugins/admin";

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
async function createInitialAdmin(request, env, adminPath, details) {
  const auth = createLocalAuth(request, env, adminPath);
  await auth.api.createUser({ body: { ...details, role: "admin" } });
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
function LocalAuthAdapter(adminPath = "/admin") {
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const adapter = {
    async getUser(request) {
      const env = await getLocalAuthEnv();
      const accessEmail = await getAccessEmail(request, env);
      if (accessEmail === null) return null;
      const auth = createLocalAuth(request, env, normalizedPath);
      const result = await auth.api.getSession({ headers: request.headers });
      const rawUser = result?.user;
      if (!rawUser || rawUser.role !== "admin" && rawUser.role !== "editor") return null;
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
      const accessEmail = await getAccessEmail(request, env);
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
        "admin/set-user-password"
      ]);
      if (!allowedActions.has(action)) {
        return new Response(null, { status: 404 });
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
      }
      if (action === "admin/create-user") {
        const body = await request.clone().json().catch(() => null);
        if (!body || !["admin", "editor"].includes(String(body.role)) || typeof body.password !== "string" || body.password.length < 12) {
          return Response.json({ error: "Choose an admin or editor role and a password of at least 12 characters" }, { status: 400 });
        }
      }
      const resetBody = action === "admin/set-user-password" ? await request.clone().json().catch(() => null) : null;
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
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/local",
      exportName: "LocalAuthAdapter",
      type: "factory",
      args: [normalizedPath]
    },
    enumerable: false
  });
  return adapter;
}
export {
  LocalAuthAdapter,
  createInitialAdmin,
  getAccessEmail,
  getLocalAuthEnv
};
