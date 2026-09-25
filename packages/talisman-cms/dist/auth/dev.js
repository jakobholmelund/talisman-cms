import "../chunk-MLKGABMK.js";

// src/auth/dev.ts
var LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
function isViteDevServer() {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}
function DevAuthAdapter() {
  const adapter = {
    async getUser(req) {
      if (!isViteDevServer()) return null;
      const hostname = new URL(req.url).hostname;
      if (!LOOPBACK_HOSTS.includes(hostname)) {
        return null;
      }
      return {
        id: "dev-user-001",
        email: "admin@talisman-cms.local",
        name: "Local Developer",
        role: "admin"
      };
    },
    async signIn() {
      return new Response("Sign In Not Implemented for Dev Adapter", { status: 501 });
    },
    async signOut() {
      return new Response("Sign Out Not Implemented for Dev Adapter", { status: 501 });
    }
  };
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/dev",
      exportName: "DevAuthAdapter",
      type: "factory"
    },
    enumerable: false
  });
  return adapter;
}
export {
  DevAuthAdapter
};
