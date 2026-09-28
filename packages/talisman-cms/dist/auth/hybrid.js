import {
  LocalAuthAdapter,
  normalizeAuthAdminPath
} from "../chunk-UYRB5J6M.js";
import "../chunk-FEIHHCEJ.js";
import "../chunk-BUMDQFAO.js";
import "../chunk-SWN7UFQB.js";
import "../chunk-GAOPNFAO.js";
import "../chunk-MLKGABMK.js";

// src/auth/hybrid.ts
function HybridAuthAdapter(adminPath) {
  const normalizedPath = normalizeAuthAdminPath(adminPath);
  const adapter = LocalAuthAdapter(normalizedPath, { requireAccess: false, editorOnly: true });
  Object.defineProperty(adapter, "__talismanAuthRuntime", {
    value: {
      moduleId: "talisman-cms/auth/hybrid",
      exportName: "HybridAuthAdapter",
      type: "factory",
      args: [],
      adminPath: true,
      ...adminPath === void 0 ? {} : { configuredAdminPath: normalizedPath }
    },
    enumerable: false,
    configurable: true
  });
  return adapter;
}
export {
  HybridAuthAdapter
};
