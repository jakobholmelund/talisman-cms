import assert from 'node:assert/strict';
import test from 'node:test';
import { rasterImageType, secureMediaResponse } from '../dist/db/media-policy.js';

test('media types come from raster signatures rather than supplied metadata', () => {
  assert.equal(rasterImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(rasterImageType(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(rasterImageType(new TextEncoder().encode('<script>alert(1)</script>')), null);
  assert.equal(rasterImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null);
});

test('legacy active uploads are downloaded even when returned from edge cache', async () => {
  const legacy = new Response('<script>alert(1)</script>', {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000' },
  });
  const protectedResponse = secureMediaResponse(legacy);
  assert.equal(protectedResponse.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(protectedResponse.headers.get('Content-Disposition'), 'attachment');
  assert.equal(protectedResponse.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(protectedResponse.headers.get('Content-Security-Policy'), 'sandbox');
  assert.equal(await protectedResponse.text(), '<script>alert(1)</script>');
});

test('raster images remain inline with safe response headers', () => {
  const image = secureMediaResponse(new Response(Uint8Array.from([0xff, 0xd8, 0xff]), {
    headers: { 'Content-Type': 'image/jpeg' },
  }));
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(image.headers.get('Content-Disposition'), null);
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
});
