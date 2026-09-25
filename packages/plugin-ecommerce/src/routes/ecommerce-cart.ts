import type { APIRoute } from 'astro';
import { bindCommerceApi } from '../api';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '../accounts';
import { ensureCartSession, readCartSessionToken } from '../cookies';
import type { carts } from '../schema';
import type { TalismanEnv } from 'talisman-cms/client';

/** The basket as the browser sees it; the token stays in its httpOnly cookie. */
function publicCart(cart: Pick<typeof carts.$inferSelect, 'id' | 'items' | 'checkoutSessionId'> | null | undefined) {
  return { id: cart?.id ?? null, items: cart?.items ?? [], locked: Boolean(cart?.checkoutSessionId) };
}

/** The shopper's open basket, linking a browser basket to a signed-in account. Never creates one. */
async function currentCart(api: ReturnType<typeof bindCommerceApi>, sessionToken: string | undefined, customerId?: string) {
  return (customerId && sessionToken ? await api.carts.claim(sessionToken, customerId) : null) ??
    await api.carts.find(sessionToken, customerId);
}

/** Well above the largest valid basket: 100 items with 128-character ids is about 30 KB of JSON. */
const MAX_CART_BODY_BYTES = 64 * 1024;

/** Read the posted item list before anything is written, bounding the body even without a Content-Length. */
async function readCartItems(request: Request): Promise<unknown[] | Response> {
  const tooLarge = () => Response.json({ error: 'Basket request is too large' }, { status: 413 });
  if (Number(request.headers.get('content-length') || 0) > MAX_CART_BODY_BYTES) return tooLarge();
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
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
  let items: unknown;
  try {
    items = JSON.parse(text + decoder.decode())?.items;
  } catch {
    return Response.json({ error: 'Cart request must be JSON' }, { status: 400 });
  }
  return Array.isArray(items) ? items : Response.json({ error: 'Cart items must be an array' }, { status: 400 });
}

export const ALL: APIRoute = async ({ request, cookies }) => {
  try {
    const { env } = await import('cloudflare:workers');
    // In a real scenario you would pass registered payment adapters from the plugin config
    const api = bindCommerceApi({ env: env as unknown as TalismanEnv });
    const customer = await findCustomerSession(env as unknown as TalismanEnv, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);

    if (request.method === 'GET') {
      // Reading never creates a basket or its cookie; the first POST does.
      const cart = await currentCart(api, readCartSessionToken(cookies), customer?.id);
      return Response.json(publicCart(cart), { headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) {
        return Response.json({ error: 'Same-origin request required' }, { status: 403 });
      }
      const items = await readCartItems(request);
      if (items instanceof Response) return items;
      // Emptying a basket that does not exist yet writes nothing: no row and no cookie.
      if (!items.length && !(await currentCart(api, readCartSessionToken(cookies), customer?.id))) {
        return Response.json(publicCart(null));
      }
      // Reuse the basket cookie, adopting one set under the legacy name, or mint a new one
      const sessionToken = ensureCartSession(cookies, new URL(request.url).protocol === 'https:');

      const cart = await api.carts.getOrCreate(sessionToken, customer?.id);
      if (!cart) {
         return new Response(JSON.stringify({ error: 'Failed to find or create cart' }), { status: 500 });
      }
      
      const updated = await api.carts.updateItems(cart.id, items as Parameters<typeof api.carts.updateItems>[1]);
      
      return new Response(JSON.stringify(publicCart(updated)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  } catch (error: any) {
    if (
      error.message === 'Cart is closed' ||
      error.message === 'Basket belongs to another account' ||
      error.message?.startsWith('Both baskets have items') ||
      error.message?.startsWith('Basket changed during account upgrade') ||
      error.message === 'Checkout already started for this cart' ||
      error.message?.startsWith('Basket changed or checkout') ||
      error.message?.startsWith('Insufficient stock for ')
    ) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (error.message?.startsWith('Cart items must') || error.message === 'Duplicate cart items are not allowed') {
      return Response.json({ error: error.message }, { status: 400 });
    }

    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
