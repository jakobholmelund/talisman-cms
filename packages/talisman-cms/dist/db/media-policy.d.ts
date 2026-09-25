declare const MAX_MEDIA_BYTES: number;
/** Determine the stored type from bytes rather than the browser supplied MIME type. */
declare function rasterImageType(bytes: Uint8Array): string | null;
/** Protect both newly uploaded files and objects cached before upload validation existed. */
declare function secureMediaResponse(response: Response): Response;

export { MAX_MEDIA_BYTES, rasterImageType, secureMediaResponse };
