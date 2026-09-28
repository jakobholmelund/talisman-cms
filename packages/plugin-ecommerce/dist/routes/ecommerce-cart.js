import {
  basketCreationOverLimit,
  basketLimitResponse
} from "../chunk-QH74PGQU.js";
import {
  bindCommerceApi
} from "../chunk-2HRMHYMK.js";
import "../chunk-TPW5F2YY.js";
import "../chunk-SWPC7XQH.js";
import "../chunk-BGDJXEM5.js";
import {
  ensureCartSession,
  readCartSessionToken
} from "../chunk-MDTTSWBR.js";
import "../chunk-6CXRXC6K.js";
import "../chunk-HOPUAWN7.js";
import "../chunk-2XVZABM5.js";
import "../chunk-GNU6N22K.js";
import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-2WZJA37J.js";
import "../chunk-DUYAQ7V4.js";
import "../chunk-NKJTK7MK.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-cart.ts
function publicCart(cart) {
  return { id: cart?.id ?? null, items: cart?.items ?? [], locked: Boolean(cart?.checkoutSessionId) };
}
async function currentCart(api, sessionToken, customerId) {
  return (customerId && sessionToken ? await api.carts.claim(sessionToken, customerId) : null) ?? await api.carts.find(sessionToken, customerId);
}
var MAX_CART_BODY_BYTES = 64 * 1024;
async function readCartItems(request) {
  const tooLarge = () => Response.json({ error: "Basket request is too large" }, { status: 413 });
  if (Number(request.headers.get("content-length") || 0) > MAX_CART_BODY_BYTES) return tooLarge();
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_CART_BODY_BYTES) {
      await reader.cancel();
      return tooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  let items;
  try {
    items = JSON.parse(text + decoder.decode())?.items;
  } catch {
    return Response.json({ error: "Cart request must be JSON" }, { status: 400 });
  }
  return Array.isArray(items) ? items : Response.json({ error: "Cart items must be an array" }, { status: 400 });
}
var ALL = async ({ request, cookies }) => {
  try {
    const { env } = await import("cloudflare:workers");
    const api = bindCommerceApi({ env });
    const customer = await findCustomerSession(env, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    if (request.method === "GET") {
      const cart = await currentCart(api, readCartSessionToken(cookies), customer?.id);
      return Response.json(publicCart(cart), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST") {
      if (request.headers.get("origin") !== new URL(request.url).origin) {
        return Response.json({ error: "Same-origin request required" }, { status: 403 });
      }
      const items = await readCartItems(request);
      if (items instanceof Response) return items;
      const existing = await currentCart(api, readCartSessionToken(cookies), customer?.id);
      if (!items.length && !existing) {
        return Response.json(publicCart(null));
      }
      const checked = await api.carts.validateItems(items, existing?.items);
      if (!existing && await basketCreationOverLimit(env, request.headers.get("cf-connecting-ip"))) {
        return basketLimitResponse();
      }
      const sessionToken = ensureCartSession(cookies, new URL(request.url).protocol === "https:");
      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      if (!cart) {
        return new Response(JSON.stringify({ error: "Failed to find or create cart" }), { status: 500 });
      }
      const updated = await api.carts.updateItems(cart.id, checked);
      return new Response(JSON.stringify(publicCart(updated)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  } catch (error) {
    if (error.message === "Cart is closed" || error.message === "Basket belongs to another account" || error.message?.startsWith("Both baskets have items") || error.message?.startsWith("Basket changed during account upgrade") || error.message === "Checkout already started for this cart" || error.message?.startsWith("Basket changed or checkout") || error.message?.startsWith("Insufficient stock for ")) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (error.message?.startsWith("Cart items must") || error.message === "Duplicate cart items are not allowed") {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
export {
  ALL
};
