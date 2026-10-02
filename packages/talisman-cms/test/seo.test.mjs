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

test('canonical, breadcrumb and sitemap paths stay on the configured origin after normalization', () => {
  for (const path of ['/x/..//other.example/page', '/x/%2e%2e//other.example/page', '/\\other.example/page', '//other.example/page', 'https://other.example/page', '/[', null, undefined]) {
    const result = resolveSeo({ siteUrl: 'https://example.com/base?query=1#hash', path,
      site: {}, page: { breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Page', path }] }, publicIndexing: false });
    assert.equal(new URL(result.canonical).origin, 'https://example.com');
    assert.equal(new URL(result.jsonLd.at(-1).itemListElement[1].item).origin, 'https://example.com');
    assert.doesNotMatch(renderSitemapXml('https://example.com', [path]), /<loc>https:\/\/other/);
  }
  assert.equal(resolveSeo({ siteUrl: 'https://example.com', path: '/', site: { titleSuffix: 'Example' }, page: {}, publicIndexing: false }).title, '');
});

test('empty page and site titles do not create a separator-only suffix title', () => {
  assert.equal(resolveSeo({ siteUrl: 'https://example.com', path: '/', site: { titleSuffix: 'Example' }, page: { title: ' ' }, publicIndexing: false }).title, '');
});

test('malformed breadcrumb paths resolve safely instead of throwing', () => {
  const result = resolveSeo({ siteUrl: 'https://example.com', path: '/page', site: {}, page: { breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Page', path: null }] }, publicIndexing: false });
  assert.equal(result.jsonLd.at(-1).itemListElement[1].item, 'https://example.com/');
});
