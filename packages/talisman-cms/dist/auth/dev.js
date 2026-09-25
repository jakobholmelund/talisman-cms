import "../chunk-MLKGABMK.js";

// src/auth/dev.ts
function DevAuthAdapter() {
  const adapter = {
    async getUser(req) {
      const hostname = new URL(req.url).hostname;
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
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
