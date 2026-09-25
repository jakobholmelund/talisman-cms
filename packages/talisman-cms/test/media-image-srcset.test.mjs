import assert from 'node:assert/strict';
import test from 'node:test';
import { getMediaImageSrcSet } from '../dist/helpers.js';

test('CMS media srcsets use only supported transformation widths', () => {
  assert.equal(
    getMediaImageSrcSet('/api/media/media_123_abc', [320, 640, 777]),
    '/api/media/media_123_abc?w=320 320w, /api/media/media_123_abc?w=640 640w'
  );
  assert.equal(getMediaImageSrcSet('https://example.com/photo.jpg'), undefined);
  assert.equal(getMediaImageSrcSet('https://example.com/api/media/media_123_abc'), undefined);
  assert.equal(getMediaImageSrcSet('/api/media/media_123_abc', [777]), undefined);
});
