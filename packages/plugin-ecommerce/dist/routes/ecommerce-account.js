import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_MAX_AGE,
  consumeCustomerEmailSignIn,
  findCustomerSession,
  requestCustomerEmailSignIn,
  revokeCustomerSession
} from "../chunk-OM7CZNWS.js";
import {
  bindCommerceApi
} from "../chunk-4B5ROQI2.js";
import "../chunk-MQPA2QMJ.js";
import "../chunk-PRGHPNDB.js";
import {
  CART_SESSION_COOKIE,
  LEGACY_CART_SESSION_COOKIE,
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-AGAY2N6E.js";
import "../chunk-U46CR236.js";
import "../chunk-6RT3KMIV.js";

// src/routes/ecommerce-account.ts
var ALL = async ({ request, cookies }) => {
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env;
  const sessionToken = cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") {
    const account = await findCustomerSession(runtimeEnv, sessionToken);
    return Response.json({ account: account ? { id: account.id, email: account.email, name: account.name } : null }, { headers });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  if (request.method === "DELETE") {
    await revokeCustomerSession(runtimeEnv, sessionToken);
    cookies.delete(CUSTOMER_SESSION_COOKIE, { path: "/" });
    cookies.delete(CART_SESSION_COOKIE, { path: "/" });
    cookies.delete(LEGACY_CART_SESSION_COOKIE, { path: "/" });
    return Response.json({ account: null }, { headers });
  }
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  const body = await request.json().catch(() => null);
  const basketToken = readCartSessionToken(cookies);
  if (typeof body?.email === "string") {
    const settings = runtimeEnv;
    const apiKey = settings.RESEND_API_KEY;
    const from = settings.GALAXY_COMMERCE_EMAIL_FROM;
    const publicOrigin = settings.GALAXY_COMMERCE_PUBLIC_ORIGIN;
    if (typeof apiKey !== "string" || !apiKey || typeof from !== "string" || !from || typeof publicOrigin !== "string" || publicOrigin !== new URL(request.url).origin) {
      return Response.json({ error: "Email sign-in is unavailable" }, { status: 503, headers });
    }
    try {
      await requestCustomerEmailSignIn(
        runtimeEnv,
        body.email,
        (token) => `${publicOrigin}/account/verify?token=${encodeURIComponent(token)}`,
        async (to, link) => {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from,
              to: [to],
              subject: "Sign in to your account",
              html: `<p>Use this one-time link to sign in. It expires in 15 minutes.</p><p><a href="${link}">Sign in</a></p>`
            })
          });
          if (!response.ok) throw new Error("Email delivery failed");
        },
        request.headers.get("cf-connecting-ip")
      );
      return Response.json({ accepted: true }, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error && error.message === "Valid email required" ? error.message : "Could not send sign-in email" }, { status: 400, headers });
    }
  }
  if (typeof body?.token === "string") {
    const result = await consumeCustomerEmailSignIn(runtimeEnv, body.token);
    if (!result) return Response.json({ error: "Sign-in link is invalid or expired" }, { status: 400, headers });
    await revokeCustomerSession(runtimeEnv, sessionToken);
    cookies.set(CUSTOMER_SESSION_COOKIE, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      maxAge: CUSTOMER_SESSION_MAX_AGE
    });
    return Response.json({ account: { id: result.account.id, email: result.account.email, name: result.account.name } }, { headers });
  }
  if (body?.basketChoice === "browser" || body?.basketChoice === "account") {
    const customer = await findCustomerSession(runtimeEnv, sessionToken);
    if (!customer || !basketToken) return Response.json({ error: "Shopper session required" }, { status: 401, headers });
    try {
      const cart = await bindCommerceApi({ env: runtimeEnv }).carts.claim(basketToken, customer.id, body.basketChoice);
      return Response.json({ cart }, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Basket could not be linked" }, { status: 409, headers });
    }
  }
  return Response.json({ error: "Invalid account action" }, { status: 400, headers });
};
export {
  ALL
};
