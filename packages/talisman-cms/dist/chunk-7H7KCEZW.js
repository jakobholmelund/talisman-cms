// src/private-response.ts
function privateHeaders(headers) {
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  const csp = headers.get("Content-Security-Policy") || "";
  headers.set("Content-Security-Policy", [...csp.split(";").map((s) => s.trim()).filter((s) => s && !/^frame-ancestors(?:\s|$)/i.test(s)), "frame-ancestors 'none'"].join("; "));
}
function privateResponse(response) {
  const headers = new Headers(response.headers);
  privateHeaders(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function privateRoute(route) {
  return async (...args) => privateResponse(await route(...args));
}

export {
  privateResponse,
  privateRoute
};
