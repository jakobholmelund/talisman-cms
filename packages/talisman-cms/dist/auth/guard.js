import {
  authorizeCmsRequestWithAdapter
} from "../chunk-DWDZS2ZS.js";
import "../chunk-MLKGABMK.js";

// src/auth/guard.ts
import { authAdapter, authConfigured } from "virtual:talisman-cms/auth";
async function authorizeCmsRequest(request, requiredRole) {
  return authorizeCmsRequestWithAdapter(request, authAdapter, authConfigured, requiredRole);
}
export {
  authorizeCmsRequest
};
