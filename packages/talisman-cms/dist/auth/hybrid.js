import {
  LocalAuthAdapter
} from "../chunk-5GPCN2YJ.js";
import "../chunk-PG2TJYKE.js";
import "../chunk-GAOPNFAO.js";
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
