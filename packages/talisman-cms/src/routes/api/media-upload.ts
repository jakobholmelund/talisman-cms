import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDbClient, invalidateEntryCache, type TalismanEnv } from '../../client';
import { media } from '../../db/schema';
import { authorizeCmsRequest } from '../../auth/guard';
import { MAX_MEDIA_BYTES, isMediaCollection, mediaPath, rasterImageType } from '../../db/media-policy';
import { loadServiceConfig } from '../../service/config';

export const POST: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request);
  if (authorization.response) return authorization.response;

  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (file.size === 0 || file.size > MAX_MEDIA_BYTES) {
      return Response.json({ error: 'Image must be between 1 byte and 10 MiB' }, { status: 413 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const mimeType = rasterImageType(new Uint8Array(arrayBuffer));
    if (!mimeType) {
      return Response.json({ error: 'Only JPEG, PNG, GIF, WebP, and AVIF images are supported' }, { status: 415 });
    }

    const { env: workerEnv } = await import('cloudflare:workers');
    const env = workerEnv as unknown as TalismanEnv;
    const db = createDbClient(env as any);

    const fileId = `media_${crypto.randomUUID()}`;
    const sizeBytes = file.size;
    if (!env.STORAGE) {
      return Response.json({ error: 'R2 storage is not configured' }, { status: 503 });
    }

    await env.STORAGE.put(fileId, arrayBuffer, {
      httpMetadata: { contentType: mimeType }
    });
    const mediaUrl = mediaPath(fileId);

    const now = new Date();

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
      // Without its record the file is not in the library, but media-serve would still serve it.
      await env.STORAGE.delete(fileId).catch((cleanupError) => {
        console.error(`Could not delete ${fileId} after its media record failed to save:`, cleanupError);
      });
      throw error;
    }

    // The library's cached reads no longer match the table.
    const { collections } = await loadServiceConfig();
    await Promise.all(collections.filter(isMediaCollection).map((collection) => invalidateEntryCache(env, collection.slug, fileId)));

    const insertedRecord = await db.select().from(media).where(eq(media.id, fileId)).get();

    return new Response(JSON.stringify(insertedRecord), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    // Database errors carry the statement and its values, so the details stay in the logs.
    console.error('Media upload error:', error);
    return new Response(JSON.stringify({ error: 'The upload could not be saved. Check the server logs for details.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
