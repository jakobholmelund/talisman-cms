import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE_COOKIE, DEFAULT_MARKET_COOKIE, hreflangLinks, localeCookie, localizedPath,
  parseAcceptLanguage, resolveLocale, splitLocalePath,
} from '../dist/locale.js';

const config = { locales: ['da', 'en'], defaultLocale: 'en', markets: ['DK', 'SE', 'US'], defaultMarket: 'US' };

function request(path, headers = {}, method = 'GET') {
  return new Request(`https://example.com${path}`, { method, headers });
}

test('Accept-Language parses by quality, keeps header order among equals and drops malformed entries', () => {
  assert.deepEqual(parseAcceptLanguage('sv;q=0.5, da-DK, en;q=0.8, *;q=0.1, not a tag, de;q=abc'), [
    { tag: 'da-DK', q: 1 }, { tag: 'en', q: 0.8 }, { tag: 'sv', q: 0.5 }, { tag: '*', q: 0.1 },
  ]);
  assert.deepEqual(parseAcceptLanguage(null), []);
  assert.deepEqual(parseAcceptLanguage('en;q=2'), []);
  assert.equal(parseAcceptLanguage(Array.from({ length: 100 }, (_, i) => `x-${i}`).join(',')).length, 32);
});

test('the path prefix decides the language and is never redirected', () => {
  const result = resolveLocale(request('/da/shop', { 'accept-language': 'en', cookie: `${DEFAULT_LOCALE_COOKIE}=en` }), config);
  assert.equal(result.locale, 'da');
  assert.equal(result.source.locale, 'path');
  assert.equal(result.redirectTo, undefined);
  assert.equal(resolveLocale(request('/DA'), config).locale, 'da');
});

test('cookie beats Accept-Language, which beats the default', () => {
  const both = resolveLocale(request('/', { 'accept-language': 'da', cookie: `${DEFAULT_LOCALE_COOKIE}=en` }), config);
  assert.deepEqual([both.locale, both.source.locale], ['en', 'cookie']);
  const header = resolveLocale(request('/', { 'accept-language': 'sv, da-DK;q=0.9, en;q=0.5' }), config);
  assert.deepEqual([header.locale, header.source.locale], ['da', 'header']);
  const none = resolveLocale(request('/', { 'accept-language': 'sv, de' }), config);
  assert.deepEqual([none.locale, none.source.locale], ['en', 'default']);
  const junkCookie = resolveLocale(request('/', { cookie: `${DEFAULT_LOCALE_COOKIE}=xx`, 'accept-language': 'da' }), config);
  assert.equal(junkCookie.locale, 'da');
});

test('a region tag matches its language and q=0 or a wildcard never selects one', () => {
  assert.equal(resolveLocale(request('/', { 'accept-language': 'da-DK' }), config).locale, 'da');
  assert.equal(resolveLocale(request('/', { 'accept-language': 'da;q=0, *' }), config).source.locale, 'default');
  const regional = { locales: ['pt', 'pt-BR', 'en'], defaultLocale: 'en' };
  assert.equal(resolveLocale(request('/', { 'accept-language': 'pt-PT' }), regional).locale, 'pt');
  assert.equal(resolveLocale(request('/', { 'accept-language': 'pt-br' }), regional).locale, 'pt-BR');
  assert.equal(resolveLocale(request('/', { 'accept-language': 'pt' }), { locales: ['pt-BR', 'en'], defaultLocale: 'en' }).locale, 'pt-BR');
});

test('an unprefixed page request redirects to its language, keeping the query', () => {
  const result = resolveLocale(request('/shop/frame?lens=rose', { 'accept-language': 'da' }), config);
  assert.equal(result.redirectTo, '/da/shop/frame?lens=rose');
  assert.equal(resolveLocale(request('/', { 'accept-language': 'da' }), config).redirectTo, '/da');
  assert.equal(resolveLocale(request('/', {}, 'HEAD'), config).redirectTo, '/en');
  assert.equal(resolveLocale(request('/', {}, 'POST'), config).redirectTo, undefined);
});

test('a path that starts with two slashes stays on the site when prefixed', () => {
  assert.equal(resolveLocale(request('//evil.example/x'), config).redirectTo, '/en//evil.example/x');
});

test('crawlers get the default language and market and no redirect', () => {
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'accept-language': 'da', cookie: `${DEFAULT_LOCALE_COOKIE}=da` };
  const result = resolveLocale(request('/shop', headers), config, { country: 'DK' });
  assert.deepEqual([result.locale, result.market, result.redirectTo], ['en', 'US', undefined]);
  const flagged = resolveLocale(request('/shop', { 'accept-language': 'da' }), config, { crawler: true, country: 'DK' });
  assert.deepEqual([flagged.locale, flagged.market, flagged.redirectTo], ['en', 'US', undefined]);
  assert.equal(resolveLocale(request('/shop', headers), config, { crawler: false }).locale, 'da');
});

test('market: cookie, then country, then the default, limited to the configured markets', () => {
  const cookie = resolveLocale(request('/', { cookie: `${DEFAULT_MARKET_COOKIE}=se` }), config, { country: 'DK' });
  assert.deepEqual([cookie.market, cookie.source.market], ['SE', 'cookie']);
  const geo = resolveLocale(request('/'), config, { country: 'dk' });
  assert.deepEqual([geo.market, geo.source.market], ['DK', 'geo']);
  const header = resolveLocale(request('/', { 'cf-ipcountry': 'SE' }), config);
  assert.deepEqual([header.market, header.source.market], ['SE', 'geo']);
  const outside = resolveLocale(request('/'), config, { country: 'JP' });
  assert.deepEqual([outside.market, outside.source.market], ['US', 'default']);
  const badCookie = resolveLocale(request('/', { cookie: `${DEFAULT_MARKET_COOKIE}=JP` }), config, { country: 'DK' });
  assert.deepEqual([badCookie.market, badCookie.source.market], ['DK', 'geo']);
});

test('unknown countries (XX, T1, junk) count as no country', () => {
  for (const country of ['XX', 'T1', '', 'DENMARK', null]) {
    assert.equal(resolveLocale(request('/'), config, { country }).source.market, 'default', String(country));
  }
});

test('without markets any country is accepted and the market may be null', () => {
  const open = { locales: ['en'], defaultLocale: 'en' };
  assert.equal(resolveLocale(request('/en'), open, { country: 'JP' }).market, 'JP');
  const none = resolveLocale(request('/en'), open);
  assert.deepEqual([none.market, none.source.market], [null, 'default']);
});

test('custom cookie names are read', () => {
  const named = { ...config, cookie: { locale: 'lang', market: 'shop' } };
  const result = resolveLocale(request('/', { cookie: 'a=b; lang=da; shop=SE' }), named);
  assert.deepEqual([result.locale, result.market], ['da', 'SE']);
});

test('localizedPath adds or replaces the prefix and splitLocalePath takes it off', () => {
  assert.equal(localizedPath('/', 'da', config), '/da');
  assert.equal(localizedPath('/shop', 'da', config), '/da/shop');
  assert.equal(localizedPath('/en/shop/frame', 'da', config), '/da/shop/frame');
  assert.equal(localizedPath('shop', 'DA', config), '/da/shop');
  assert.equal(localizedPath('/english', 'da', config), '/da/english');
  assert.throws(() => localizedPath('/', 'sv', config), RangeError);
  assert.deepEqual(splitLocalePath('/da/shop', config), { locale: 'da', path: '/shop' });
  assert.deepEqual(splitLocalePath('/da', config), { locale: 'da', path: '/' });
  assert.deepEqual(splitLocalePath('/shop', config), { path: '/shop' });
});

test('hreflang links cover every language and point x-default at the default', () => {
  assert.deepEqual(hreflangLinks('/da/shop', 'https://example.com', config), [
    { hreflang: 'da', href: 'https://example.com/da/shop' },
    { hreflang: 'en', href: 'https://example.com/en/shop' },
    { hreflang: 'x-default', href: 'https://example.com/en/shop' },
  ]);
});

test('the choice cookie is secure by default and refuses header-breaking values', () => {
  assert.equal(localeCookie('talisman-locale', 'da'), 'talisman-locale=da; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  assert.equal(localeCookie('talisman-locale', 'da', { secure: false, maxAge: 60 }), 'talisman-locale=da; Path=/; Max-Age=60; SameSite=Lax');
  assert.throws(() => localeCookie('talisman-locale', 'da\r\nSet-Cookie: x=y'));
  assert.throws(() => localeCookie('bad name', 'da'));
});

test('a bad configuration fails with the field named', () => {
  const bad = (patch, message) => assert.throws(() => resolveLocale(request('/'), { ...config, ...patch }), message);
  bad({ locales: [] }, /at least one/);
  bad({ locales: ['da', 'DA'], defaultLocale: 'da' }, /listed twice/);
  bad({ locales: ['da', 'e n'] }, /not a language tag/);
  bad({ defaultLocale: 'sv' }, /defaultLocale/);
  bad({ markets: ['DK', 'Denmark'] }, /not a country code/);
  bad({ defaultMarket: 'JP' }, /not in markets/);
  bad({ defaultMarket: undefined }, /defaultMarket is required/);
  bad({ cookie: { locale: 'a b' } }, /cookie name/);
});
