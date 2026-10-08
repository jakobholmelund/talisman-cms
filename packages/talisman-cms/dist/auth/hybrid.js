import {
  LocalAuthAdapter,
  normalizeAuthAdminPath
} from "../chunk-D75DP4UR.js";
import "../chunk-TKMQLVY7.js";
import "../chunk-WHOEA75K.js";
import "../chunk-FEIHHCEJ.js";
import "../chunk-BUMDQFAO.js";
import "../chunk-HEG7DNCN.js";
import "../chunk-7VUPBVR5.js";
import "../chunk-O4C7JAHB.js";
import "../chunk-SHMAAJ4S.js";
import "../chunk-72N3XJ7X.js";
import "../chunk-GAOPNFAO.js";
import "../chunk-LQQ27M3S.js";
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
