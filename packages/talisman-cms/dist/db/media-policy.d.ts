declare const MAX_MEDIA_BYTES: number;
/** The widths media-serve resizes images to (with an IMAGES binding) for `?w=`. */
declare const MEDIA_IMAGE_WIDTHS: readonly [320, 640, 960, 1280, 1920];
/**
 * Browsers and the edge cache keep a file for an hour and then revalidate it with its ETag, so a
 * deleted file stops being served everywhere within the hour.
 */
declare const MEDIA_CACHE_CONTROL = "public, max-age=3600";
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
type MediaStorageEnv = {
    STORAGE?: Pick<R2Bucket, 'delete'>;
};
/**
 * Removes a deleted media record's file from R2, then evicts its cached copies (the original and every
 * width) from this data center's edge cache. Other data centers drop theirs when they expire, which
 * MEDIA_CACHE_CONTROL keeps to an hour; a zone-wide purge needs Cloudflare's purge API.
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

export { MAX_MEDIA_BYTES, MEDIA_CACHE_CONTROL, MEDIA_IMAGE_WIDTHS, MEDIA_SCHEMA_PATH, deleteStoredMedia, isMediaCollection, mediaCacheKey, mediaPath, notModifiedResponse, rasterImageType, secureMediaResponse };
