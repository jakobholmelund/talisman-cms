// src/auth/authorize.ts
function errorResponse(status, error) {
  return Response.json({ error }, { status });
}
async function authorizeCmsRequestWithAdapter(request, authAdapter, authConfigured, requiredRole) {
  if (authConfigured && !authAdapter) {
    return { response: errorResponse(500, "CMS auth adapter could not be loaded at runtime") };
  }
  if (!authAdapter) {
    return { response: errorResponse(503, "CMS auth adapter is not configured") };
  }
  const origin = request.headers.get("origin");
  if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (origin !== new URL(request.url).origin) {
      return { response: errorResponse(403, "Cross-origin CMS changes are forbidden") };
    }
  }
  const user = await authAdapter.getUser(request);
  if (!user) {
    return { response: errorResponse(401, "Unauthorized") };
  }
  if (requiredRole === "admin" && user.role !== "admin") {
    return { response: errorResponse(403, "Admin access required") };
  }
  return { user };
}

export {
  authorizeCmsRequestWithAdapter
};
