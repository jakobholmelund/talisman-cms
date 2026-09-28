import {
  readSetting
} from "./chunk-GAOPNFAO.js";

// src/auth/access.ts
import { createRemoteJWKSet, jwtVerify } from "jose";
var jwksCache = /* @__PURE__ */ new Map();
async function getAccessEnv() {
  try {
    const worker = await import("cloudflare:workers");
    return worker.env;
  } catch {
    return process.env;
  }
}
async function getAccessEmail(request, env) {
  const teamDomain = readSetting(env, "ACCESS_TEAM_DOMAIN");
  const audience = readSetting(env, "ACCESS_AUDIENCE");
  if (!teamDomain && !audience) return void 0;
  if (!teamDomain || !audience || !/^https:\/\/[^/]+\.cloudflareaccess\.com\/?$/.test(teamDomain)) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const issuer = teamDomain.replace(/\/$/, "");
  try {
    let jwks = jwksCache.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksCache.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ["RS256"] });
    return typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
function allowedEmails(value) {
  return new Set((value || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}
function AccessAuthAdapter(adminPath = "/admin") {
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const adapter = {
    async getUser(request) {
      const env = await getAccessEnv();
      if (!readSetting(env, "ACCESS_TEAM_DOMAIN") || !readSetting(env, "ACCESS_AUDIENCE")) return null;
      const email = await getAccessEmail(request, env);
      if (!email) return null;
      const admins = allowedEmails(readSetting(env, "ACCESS_ADMIN_EMAILS"));
      const editors = allowedEmails(readSetting(env, "ACCESS_EDITOR_EMAILS"));
      const role = admins.has(email) ? "admin" : editors.has(email) ? "editor" : null;
      if (!role) return null;
      return { id: `cloudflare-access:${email}`, email, role };
    },
    async signIn(request) {
      return Response.redirect(new URL(normalizedPath, request.url));
    },
    async signOut(request) {
      return Response.redirect(new URL("/cdn-cgi/access/logout", request.url));
    }
  };
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/access",
      exportName: "AccessAuthAdapter",
      type: "factory",
      args: [normalizedPath]
    },
    enumerable: false
  });
  return adapter;
}

export {
  getAccessEmail,
  AccessAuthAdapter
};
