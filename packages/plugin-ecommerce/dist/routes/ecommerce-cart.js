import {
  CUSTOMER_SESSION_COOKIE,
  findCustomerSession
} from "../chunk-SRJQDDQH.js";
import {
  bindCommerceApi
} from "../chunk-LVJ6XT5P.js";
import "../chunk-MPVZ6EEH.js";
import "../chunk-LHGIEHI6.js";
import "../chunk-JB5GG7SZ.js";
import "../chunk-53CI56PJ.js";
import "../chunk-XLYDGTBP.js";

// src/routes/ecommerce-cart.ts
var ALL = async ({ request, cookies }) => {
  let sessionToken = cookies.get("talisman-cart")?.value;
  if (!sessionToken) {
    sessionToken = `anon_${crypto.randomUUID()}`;
    cookies.set("talisman-cart", sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      maxAge: 60 * 60 * 24 * 30
    });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const api = bindCommerceApi({ env });
    const customer = await findCustomerSession(env, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
    if (request.method === "GET") {
      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      return new Response(JSON.stringify(cart), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST") {
      if (request.headers.get("origin") !== new URL(request.url).origin) {
        return Response.json({ error: "Same-origin request required" }, { status: 403 });
      }
      const body = await request.json();
      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      if (!cart) {
        return new Response(JSON.stringify({ error: "Failed to find or create cart" }), { status: 500 });
      }
      const updated = await api.carts.updateItems(cart.id, body.items);
      return new Response(JSON.stringify(updated), {
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
