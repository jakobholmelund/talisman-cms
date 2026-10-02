import {
  privateRoute
} from "../../../chunk-7H7KCEZW.js";
import {
  signInCloudflareAdmin
} from "../../../chunk-ED6DT7ED.js";
import "../../../chunk-R6I6DIQJ.js";
import "../../../chunk-WHOEA75K.js";
import "../../../chunk-FEIHHCEJ.js";
import "../../../chunk-BUMDQFAO.js";
import "../../../chunk-T4XA2AEL.js";
import "../../../chunk-7VUPBVR5.js";
import "../../../chunk-O4C7JAHB.js";
import "../../../chunk-SHMAAJ4S.js";
import "../../../chunk-72N3XJ7X.js";
import "../../../chunk-GAOPNFAO.js";
import "../../../chunk-OAGJMNST.js";
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
