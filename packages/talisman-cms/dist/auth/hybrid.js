import {
  LocalAuthAdapter
} from "../chunk-CMGROHSI.js";
import "../chunk-XMM5SQBN.js";
import "../chunk-ACDUZVLI.js";
import "../chunk-VVR3XKHB.js";
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
