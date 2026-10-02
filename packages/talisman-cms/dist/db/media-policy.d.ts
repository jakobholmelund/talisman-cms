declare const MAX_MEDIA_BYTES: number;
/** The widths media-serve resizes images to (with an IMAGES binding) for `?w=`. */
declare const MEDIA_IMAGE_WIDTHS: readonly [320, 640, 960, 1280, 1920];
/** Browsers revalidate; the edge stores bytes, but checks the durable deletion marker first. */
declare const MEDIA_CACHE_CONTROL = "public, max-age=0, must-revalidate";
declare const MEDIA_EDGE_CACHE_CONTROL = "public, max-age=3600";
declare const MEDIA_FALLBACK_CACHE_CONTROL = "public, max-age=60";
declare const MEDIA_SCHEMA_PATH = "talisman-cms/db/media";
/** Whether a configured collection is backed by the media table (the built-in `media` collection). */
declare function isMediaCollection(collection: {
    nativeSchemaMapping?: {
        schemaPath?: string;
    };
}): boolean;
/** The public path of an uploaded file: media-serve answers at `/api/media/<id>`. */
declare function mediaPath(id: string): string;
/** The edge-cache key media-serve uses for one file, as the original or at one resize width. */
declare function mediaCacheKey(origin: string, id: string, width?: number): string;
declare const mediaDeletionKey: (id: string) => string;
type MediaStorageEnv = {
    STORAGE?: Pick<R2Bucket, 'delete' | 'put'>;
};
/**
 * Write a durable R2 tombstone before removing bytes. Every cache location checks it before serving
 * a hit; ids are never reused, so tombstones are retained. Local eviction only saves cache space.
 */
declare function deleteStoredMedia(env: MediaStorageEnv, id: string, origin?: string): Promise<void>;
/**
 * Answers a conditional request with 304 when the client already holds the response's version, so an
 * expired copy is revalidated without sending the file again.
 */
declare function notModifiedResponse(request: Request, response: Response): Response | null;
/** Determine the stored type from bytes rather than the browser supplied MIME type. */
declare function rasterImageType(bytes: Uint8Array): string | null;
/** Protect both newly uploaded files and objects cached before upload validation existed. */
declare function secureMediaResponse(response: Response): Response;

export { MAX_MEDIA_BYTES, MEDIA_CACHE_CONTROL, MEDIA_EDGE_CACHE_CONTROL, MEDIA_FALLBACK_CACHE_CONTROL, MEDIA_IMAGE_WIDTHS, MEDIA_SCHEMA_PATH, deleteStoredMedia, isMediaCollection, mediaCacheKey, mediaDeletionKey, mediaPath, notModifiedResponse, rasterImageType, secureMediaResponse };
