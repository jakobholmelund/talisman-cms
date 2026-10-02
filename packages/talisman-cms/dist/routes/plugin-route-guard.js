import {
  privateResponse
} from "../chunk-7H7KCEZW.js";
import "../chunk-MLKGABMK.js";

// src/routes/plugin-route-guard.ts
import { adminPath, protectedRoutes } from "virtual:talisman-cms/protected-routes";
var prefix = adminPath === "/" ? "" : adminPath;
var corePrivatePatterns = /* @__PURE__ */ new Set([
  adminPath,
  `${prefix}/[...route]`,
  `${prefix}/api/[...route]`,
  ...["session", "setup", "[...route]"].map((path) => `${prefix}/api/auth/${path}`),
  `${prefix}/sso`,
  `${prefix}/api/media/upload`
]);
var onRequest = async (context, next) => {
  const kind = Object.hasOwn(protectedRoutes, context.routePattern) ? protectedRoutes[context.routePattern] : void 0;
  if (!kind) {
    const response = await next();
    return corePrivatePatterns.has(context.routePattern.replace(/\/$/, "") || "/") ? privateResponse(response) : response;
  }
  const { authorizeCmsRequest } = await import("../auth/guard.js");
  const authorization = await authorizeCmsRequest(context.request);
  if (!authorization.response) return privateResponse(await next());
  if (kind === "page" && authorization.response.status === 401) {
    return privateResponse(new Response(null, { status: 302, headers: { Location: adminPath } }));
  }
  return authorization.response;
};
export {
  onRequest
};
