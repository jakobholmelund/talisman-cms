export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const safeImageTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);

/** Determine the stored type from bytes rather than the browser supplied MIME type. */
export function rasterImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' &&
      ['avif', 'avis'].includes(String.fromCharCode(...bytes.slice(8, 12)))) return 'image/avif';
  return null;
}

/** Protect both newly uploaded files and objects cached before upload validation existed. */
export function secureMediaResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const type = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() || '';
  if (safeImageTypes.has(type)) {
    headers.set('Content-Type', type);
    headers.delete('Content-Disposition');
  } else {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
