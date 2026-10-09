import {
  ShopperError
} from "./chunk-HZYMV637.js";

// src/request-body.ts
async function readBoundedJson(request, maximum = 64 * 1024) {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ShopperError("body_too_large", "Request is too large", 400);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export {
  readBoundedJson
};
