import {
  bindCommerceApi
} from "../chunk-ZCEC33U7.js";
import "../chunk-BCWAVKQF.js";
import {
  CART_SESSION_COOKIE,
  LEGACY_CART_SESSION_COOKIE,
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-YXNRHYNN.js";
import "../chunk-2RLPKBNT.js";
import "../chunk-MS53KKKY.js";
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_MAX_AGE,
  CustomerRequestLimitError,
  SHOPPER_SIGN_IN_TURNSTILE_ACTION,
  consumeCustomerEmailSignIn,
  findCustomerSession,
  normalizeShopperEmail,
  previewCustomerEmailSignIn,
  readTurnstileSettings,
  requestCustomerEmailSignIn,
  revokeCustomerSession,
  verifyTurnstileToken
} from "../chunk-NITAPJVN.js";
import "../chunk-CLEUXV3O.js";

// src/routes/ecommerce-account.ts
import { readSetting } from "talisman-cms/env";
import { isEmailDeliveryError, parseAddress, sendEmail } from "talisman-cms/email";
import { getEmailProvider } from "talisman-cms/email/runtime";

// src/emails.ts
import { renderTransactionalEmail } from "talisman-cms/email";
function shopperSignInEmail({ link, siteName }) {
  return {
    kind: "shopper-sign-in",
    subject: `Sign in to ${siteName}`.replace(/[\r\n]+/g, " "),
    ...renderTransactionalEmail({
      siteName,
      heading: "Your sign-in link",
      paragraphs: ["Use this one-time link to sign in. It expires in 15 minutes and works once."],
      action: { label: "Sign in", url: link },
      footer: "If you didn't ask to sign in, you can ignore this email."
    })
  };
}

// src/routes/ecommerce-account.ts
var INVALID_LINK = "This sign-in link is invalid or has expired.";
var BOT_CHECK_FAILED = "The security check failed. Please try again.";
function logSendFailure(error) {
  if (isEmailDeliveryError(error)) {
    const details = { provider: error.provider, code: error.code, providerCode: error.providerCode ?? null };
    if (error.code === "recipient_suppressed") console.warn("[commerce] Sign-in email suppressed", details);
    else console.error("[commerce] Sign-in email failed", details);
  } else {
    console.error("[commerce] Sign-in email failed", { name: error instanceof Error ? error.name : typeof error });
  }
}
function originOf(value) {
  try {
    return value ? new URL(value).origin : void 0;
  } catch {
    return void 0;
  }
}
var ALL = async ({ request, cookies }) => {
  const { env, waitUntil } = await import("cloudflare:workers");
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
    const provider = getEmailProvider(settings);
    const from = readSetting(settings, "COMMERCE_EMAIL_FROM") ?? readSetting(settings, "EMAIL_FROM");
    const publicOrigin = originOf(readSetting(settings, "COMMERCE_PUBLIC_ORIGIN") ?? readSetting(settings, "PUBLIC_ORIGIN"));
    if (!provider || !from || publicOrigin !== new URL(request.url).origin) {
      console.error("[commerce] Email sign-in is not configured", {
        provider: provider?.id ?? null,
        from: Boolean(from),
        publicOrigin: !publicOrigin ? "missing" : publicOrigin === new URL(request.url).origin ? "ok" : "mismatch"
      });
      return Response.json({ error: "Email sign-in is unavailable" }, { status: 503, headers });
    }
    const turnstile = readTurnstileSettings(settings);
    if (turnstile.secretKey && !turnstile.siteKey) {
      console.error("[commerce] Email sign-in bot check is not configured", { code: "turnstile_site_key_missing" });
      return Response.json({ error: "Email sign-in is unavailable" }, { status: 503, headers });
    }
    if (!normalizeShopperEmail(body.email)) return Response.json({ error: "Valid email required" }, { status: 400, headers });
    const sourceIp = request.headers.get("cf-connecting-ip");
    if (turnstile.secretKey) {
      const { refusal, errorCodes } = await verifyTurnstileToken(turnstile.secretKey, body.turnstileToken, {
        remoteIp: sourceIp,
        expectedHostname: new URL(publicOrigin).hostname,
        expectedAction: SHOPPER_SIGN_IN_TURNSTILE_ACTION
      });
      if (refusal) {
        console.warn("[commerce] Email sign-in bot check refused", { code: refusal, errorCodes });
        return Response.json({ error: BOT_CHECK_FAILED }, { status: 403, headers });
      }
    }
    const siteName = parseAddress(from)?.name ?? new URL(publicOrigin).host;
    try {
      const { limited } = await requestCustomerEmailSignIn(
        runtimeEnv,
        body.email,
        // The token travels in the fragment, so it never reaches the server or its request logs.
        (token) => `${publicOrigin}/account/verify#token=${encodeURIComponent(token)}`,
        async (to, link) => {
          await sendEmail(settings, { to: { email: to }, from, ...shopperSignInEmail({ link, siteName }) }, provider);
        },
        sourceIp,
        {
          // Sends from the reserved budget finish after the response, so its timing is the same for every address.
          waitUntil: typeof waitUntil === "function" ? (task) => waitUntil(task) : void 0,
          onLimitedSendError: logSendFailure
        }
      );
      if (limited) {
        console.warn("[commerce] Daily sign-in email limit reached", { pool: "general" });
        return Response.json({ accepted: true, limited: true }, { headers });
      }
      return Response.json({ accepted: true }, { headers });
    } catch (error) {
      logSendFailure(error);
      if (isEmailDeliveryError(error) && error.code === "recipient_suppressed") return Response.json({ accepted: true }, { headers });
      return Response.json({ error: "The sign-in email could not be sent. Please try again later." }, { status: 503, headers });
    }
  }
  if (body?.token !== void 0 && body.preview !== void 0 && body.preview !== false) {
    try {
      const email = await previewCustomerEmailSignIn(runtimeEnv, body.token, request.headers.get("cf-connecting-ip"));
      if (!email) return Response.json({ error: INVALID_LINK }, { status: 400, headers });
      return Response.json({ email }, { headers });
    } catch (error) {
      if (error instanceof CustomerRequestLimitError) {
        return Response.json({ error: "Too many sign-in requests. Please try again later." }, { status: 429, headers });
      }
      throw error;
    }
  }
  if (typeof body?.token === "string") {
    const result = await consumeCustomerEmailSignIn(runtimeEnv, body.token);
    if (!result) return Response.json({ error: INVALID_LINK }, { status: 400, headers });
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
