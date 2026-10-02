import {
  authorizeCmsRequestWithAdapter
} from "./chunk-RI3U7J5G.js";

// src/auth/guard.ts
import { authAdapter, authConfigured } from "virtual:talisman-cms/auth";
async function authorizeCmsRequest(request, requiredRole) {
  return authorizeCmsRequestWithAdapter(request, authAdapter, authConfigured, requiredRole);
}

export {
  authorizeCmsRequest
};
