import {
  LocalAuthAdapter
} from "../chunk-M4OMAZ73.js";
import "../chunk-6JPMDYGU.js";
import "../chunk-R6EGKTST.js";
import "../chunk-MLKGABMK.js";

// src/auth/hybrid.ts
function HybridAuthAdapter(adminPath = "/admin") {
  const normalizedPath = adminPath === "/" ? "/" : `/${adminPath.replace(/^\/+|\/+$/g, "")}`;
  const adapter = LocalAuthAdapter(normalizedPath, { requireAccess: false, editorOnly: true });
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/hybrid",
      exportName: "HybridAuthAdapter",
      type: "factory",
      args: [normalizedPath]
    },
    enumerable: false,
    configurable: true
  });
  return adapter;
}
export {
  HybridAuthAdapter
};
