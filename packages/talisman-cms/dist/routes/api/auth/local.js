import {
  privateRoute
} from "../../../chunk-7H7KCEZW.js";
import "../../../chunk-MLKGABMK.js";

// src/routes/api/auth/local.ts
import { authAdapter } from "virtual:talisman-cms/auth";
var ALL = privateRoute(async ({ request }) => {
  if (!authAdapter?.handle) {
    return Response.json({ error: "Local authentication is not configured" }, { status: 404 });
  }
  return authAdapter.handle(request);
});
export {
  ALL
};
