import {
  authorizeCmsRequest
} from "../../chunk-2VH4YUXN.js";
import "../../chunk-RI3U7J5G.js";
import {
  privateRoute
} from "../../chunk-7H7KCEZW.js";
import "../../chunk-UTPZ3FTD.js";
import {
  createDbClient,
  loadServiceConfig
} from "../../chunk-T4XA2AEL.js";
import "../../chunk-7VUPBVR5.js";
import {
  invalidateEntryCache
} from "../../chunk-O4C7JAHB.js";
import {
  media
} from "../../chunk-SHMAAJ4S.js";
import {
  MAX_MEDIA_BYTES,
  isMediaCollection,
  mediaPath,
  rasterImageType
} from "../../chunk-72N3XJ7X.js";
import "../../chunk-GAOPNFAO.js";
import "../../chunk-OAGJMNST.js";
import "../../chunk-MLKGABMK.js";

// src/routes/api/media-upload.ts
import { eq } from "drizzle-orm";
var POST = privateRoute(async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (file.size === 0 || file.size > MAX_MEDIA_BYTES) {
      return Response.json({ error: "Image must be between 1 byte and 10 MiB" }, { status: 413 });
    }
    const arrayBuffer = await file.arrayBuffer();
    const mimeType = rasterImageType(new Uint8Array(arrayBuffer));
    if (!mimeType) {
      return Response.json({ error: "Only JPEG, PNG, GIF, WebP, and AVIF images are supported" }, { status: 415 });
    }
    const { env: workerEnv } = await import("cloudflare:workers");
    const env = workerEnv;
    const db = createDbClient(env);
    const fileId = `media_${crypto.randomUUID()}`;
    const sizeBytes = file.size;
    if (!env.STORAGE) {
      return Response.json({ error: "R2 storage is not configured" }, { status: 503 });
    }
    await env.STORAGE.put(fileId, arrayBuffer, {
      httpMetadata: { contentType: mimeType }
    });
    const mediaUrl = mediaPath(fileId);
    const now = /* @__PURE__ */ new Date();
    try {
      await db.insert(media).values({
        id: fileId,
        filename: file.name,
        url: mediaUrl,
        mimeType,
        sizeBytes,
        createdAt: now,
        updatedAt: now
      });
    } catch (error) {
      await env.STORAGE.delete(fileId).catch((cleanupError) => {
        console.error(`Could not delete ${fileId} after its media record failed to save:`, cleanupError);
      });
      throw error;
    }
    const { collections } = await loadServiceConfig();
    await Promise.all(collections.filter(isMediaCollection).map((collection) => invalidateEntryCache(env, collection.slug, fileId)));
    const insertedRecord = await db.select().from(media).where(eq(media.id, fileId)).get();
    return new Response(JSON.stringify(insertedRecord), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Media upload error:", error);
    return new Response(JSON.stringify({ error: "The upload could not be saved. Check the server logs for details." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
export {
  POST
};
