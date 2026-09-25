import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeoGlobal, parseSeoSiteSettings, seoPageFromGlobal, resolveSeo, renderRobotsTxt, renderSitemapXml, serializeJsonLd } from '../dist/seo.js';

test('CMS global exposes fixed-page fields and reads saved overrides', () => {
  const global = createSeoGlobal({ pages: [{ key: 'home', label: 'Home' }] });
  assert.ok(global.fields.some((field) => field.name === 'homeSeoTitle'));
  const saved = parseSeoSiteSettings('{"homeSeoTitle":"A new title","homeSeoNoindex":true}');
  assert.deepEqual(seoPageFromGlobal(saved, 'home'), {
    title: 'A new title', description: undefined, image: undefined, noindex: true,
  });
});

test('SEO launch gate keeps page overrides out of search', () => {
  const meta = resolveSeo({
    siteUrl: 'https://example.com',
    path: '/shop/frame?lens=rose',
    site: { siteName: 'Example', defaultDescription: 'Site description', defaultImage: '/image.webp' },
    page: { title: 'Frame', description: 'Frame description', canonicalPath: '/shop/frame',
      breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Frame', path: '/shop/frame' }] },
    publicIndexing: false,
  });
  assert.equal(meta.robots, 'noindex, nofollow');
  assert.equal(meta.canonical, 'https://example.com/shop/frame');
  assert.equal(meta.image, 'https://example.com/image.webp');
  assert.equal(meta.jsonLd.at(-1)['@type'], 'BreadcrumbList');
  assert.equal(meta.description, 'Frame description');
});

test('page noindex stays effective after launch and JSON-LD escapes markup', () => {
  const meta = resolveSeo({ siteUrl: 'https://example.com', path: '/cart',
    site: { siteName: 'Example' }, page: { title: '</script>', noindex: true }, publicIndexing: true });
  assert.equal(meta.robots, 'noindex, nofollow');
  assert.doesNotMatch(serializeJsonLd(meta.jsonLd), /<\/script>/);
});

test('robots and sitemap only advertise public canonical pages', () => {
  const hidden = renderRobotsTxt({ siteUrl: 'https://example.com', publicIndexing: false,
    disallowPaths: ['/admin', '/api'], aiSearch: false, aiTraining: false });
  assert.doesNotMatch(hidden, /Sitemap:/);
  assert.match(hidden, /User-agent: OAI-SearchBot\nDisallow: \//);
  assert.match(hidden, /User-agent: GPTBot\nDisallow: \//);
  const publicRobots = renderRobotsTxt({ siteUrl: 'https://example.com', publicIndexing: true });
  assert.match(publicRobots, /Sitemap: https:\/\/example.com\/sitemap.xml/);
  const sitemap = renderSitemapXml('https://example.com', ['/', '/shop?sort=popular', '/shop']);
  assert.equal((sitemap.match(/<url>/g) || []).length, 2);
  assert.doesNotMatch(sitemap, /sort=/);
});
