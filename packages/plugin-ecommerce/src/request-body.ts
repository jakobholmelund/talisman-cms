import { ShopperError } from './shopper-errors';
/** Bound public JSON requests while reading, even without Content-Length. */
export async function readBoundedJson(request: Request, maximum = 64 * 1024): Promise<unknown> {
  const reader = request.body?.getReader(); const decoder = new TextDecoder();
  let size = 0; let text = '';
  while (reader) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new ShopperError('body_too_large', 'Request is too large', 400); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
