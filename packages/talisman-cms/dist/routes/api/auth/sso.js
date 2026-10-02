import {
  privateRoute
} from "../../../chunk-7H7KCEZW.js";
import {
  signInCloudflareAdmin
} from "../../../chunk-3YVFIRI3.js";
import "../../../chunk-WHOEA75K.js";
import "../../../chunk-FEIHHCEJ.js";
import "../../../chunk-BUMDQFAO.js";
import "../../../chunk-GAOPNFAO.js";
import "../../../chunk-MLKGABMK.js";

// src/routes/api/auth/sso.ts
import { authAdapter } from "virtual:talisman-cms/auth";
import { adminPath } from "virtual:talisman-cms/config";
var GET = privateRoute(async ({ request }) => {
  if (authAdapter?.__talismanAuthRuntime?.moduleId !== "talisman-cms/auth/hybrid") {
    return new Response(null, { status: 404 });
  }
  return signInCloudflareAdmin(request, adminPath);
});
export {
  GET
};
