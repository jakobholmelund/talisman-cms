// src/auth/cloudflare-access.ts
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
var CLOUDFLARE_ACCESS_SIGN_IN_PATH = "/sign-in/cloudflare-access";
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cloudflareAccessSignIn(options) {
  return {
    id: "talisman-cloudflare-access",
    endpoints: {
      signInCloudflareAccess: createAuthEndpoint(CLOUDFLARE_ACCESS_SIGN_IN_PATH, { method: "POST", metadata: { SERVER_ONLY: true } }, async (ctx) => {
        const headers = ctx.headers ?? new Headers();
        const email = await options.verify(headers);
        if (!email || !EMAIL.test(email) || !options.allowed().has(email)) {
          throw new APIError("FORBIDDEN", { message: "Cloudflare admin access required" });
        }
        const adapter = ctx.context.internalAdapter;
        let found = await adapter.findUserByEmail(email);
        if (!found) {
          try {
            await adapter.createUser({ email, name: email, emailVerified: true, role: "admin" }, { method: "sso-oidc" });
          } catch {
          }
          found = await adapter.findUserByEmail(email);
        }
        if (!found) throw new APIError("SERVICE_UNAVAILABLE", { message: "Cloudflare admin account could not be created" });
        let user = found.user;
        if (user.banned && !(user.banExpires && new Date(user.banExpires).getTime() < Date.now())) {
          throw new APIError("FORBIDDEN", { message: "Cloudflare admin account is unavailable" });
        }
        if (user.role !== "admin" || !user.emailVerified || user.email !== email) {
          user = await adapter.updateUser(user.id, { role: "admin", emailVerified: true, email });
        }
        for (const account of await adapter.findAccounts(user.id)) {
          if (account.providerId === "credential") await adapter.deleteAccount(account.id);
        }
        const now = Date.now();
        const stale = (await adapter.listSessions(user.id)).filter((session2) => new Date(session2.expiresAt).getTime() <= now || now - new Date(session2.createdAt).getTime() > options.maxSessionAgeMs);
        if (stale.length) await adapter.deleteSessions(stale.map((session2) => session2.token));
        const session = await adapter.createSession(user.id, false, {
          authMethod: "cloudflare",
          ipAddress: headers.get("cf-connecting-ip") || void 0,
          userAgent: headers.get("user-agent") || void 0
        });
        if (!session) throw new APIError("SERVICE_UNAVAILABLE", { message: "Cloudflare admin session failed" });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ token: session.token });
      })
    }
  };
}

export {
  CLOUDFLARE_ACCESS_SIGN_IN_PATH,
  cloudflareAccessSignIn
};
