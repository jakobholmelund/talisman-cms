/**
 * Language and market resolution for a localized site.
 *
 * Pure functions over a `Request` and a `LocaleConfig`: nothing here reads a binding or the network. The
 * visitor's country is an argument (`opts.country`, from `request.cf.country` in a Worker), which keeps the
 * helpers testable without Cloudflare. Language and market are separate: the language says which text to
 * render and comes from the URL, the visitor's choice or `Accept-Language`, never from geography; the market
 * says which country's currency, delivery and tax apply and may come from the country.
 */

export const DEFAULT_LOCALE_COOKIE = 'talisman-locale';
export const DEFAULT_MARKET_COOKIE = 'talisman-market';

export interface MarketConfig {
  /** ISO 3166-1 alpha-2 codes the site sells to. Omit to accept any country. */
  markets?: readonly string[];
  /** Used when the visitor's market is unknown or not in `markets`. Required when `markets` is set, and must be one of them. */
  defaultMarket?: string;
  cookie?: { market?: string };
}

export interface LocaleConfig extends MarketConfig {
  /** Supported language tags, such as `['da', 'en']`. Each gets its own URL prefix. */
  locales: readonly string[];
  /** Used when nothing else picks a language, and for crawlers. Must be one of `locales`. */
  defaultLocale: string;
  cookie?: { locale?: string; market?: string };
}

export interface ResolveLocaleOptions {
  /** The visitor's country (`request.cf.country`). The `CF-IPCountry` header is read when this is missing. */
  country?: string | null;
  /** Set for a verified crawler (`request.cf.botManagement.verifiedBot`); the user agent decides otherwise. */
  crawler?: boolean;
}

export interface ResolvedMarket {
  /** The market's country code, or null when nothing resolved one and the config has no default. */
  market: string | null;
  source: 'cookie' | 'geo' | 'default';
}

export interface ResolvedLocale {
  locale: string;
  market: ResolvedMarket['market'];
  source: {
    locale: 'path' | 'cookie' | 'header' | 'default';
    market: ResolvedMarket['source'];
  };
  /** Set for a GET or HEAD request to a path without a language prefix; answer it with a redirect (302). */
  redirectTo?: string;
}

const TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const COUNTRY = /^[A-Z]{2}$/;
const UNKNOWN_COUNTRIES = new Set(['XX', 'T1']);
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;
const CRAWLER_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram/i;
const MAX_ACCEPT_LANGUAGE = 1000;
const MAX_ACCEPT_ENTRIES = 32;

interface NormalizedLocales {
  locales: string[];
  defaultLocale: string;
  localeCookie: string;
}

interface NormalizedMarkets {
  markets: string[] | null;
  defaultMarket: string | null;
  marketCookie: string;
}

function normalizeLocales(config: LocaleConfig): NormalizedLocales {
  const locales = [...config.locales];
  if (!locales.length) throw new Error('LocaleConfig.locales needs at least one language.');
  const seen = new Set<string>();
  for (const tag of locales) {
    if (!TAG.test(tag)) throw new Error(`LocaleConfig.locales: "${tag}" is not a language tag.`);
    if (seen.has(tag.toLowerCase())) throw new Error(`LocaleConfig.locales: "${tag}" is listed twice.`);
    seen.add(tag.toLowerCase());
  }
  const defaultLocale = locales.find((tag) => tag.toLowerCase() === config.defaultLocale?.toLowerCase());
  if (!defaultLocale) throw new Error(`LocaleConfig.defaultLocale "${config.defaultLocale}" is not in locales.`);
  const localeCookie = config.cookie?.locale ?? DEFAULT_LOCALE_COOKIE;
  if (!COOKIE_NAME.test(localeCookie)) throw new Error(`LocaleConfig.cookie: "${localeCookie}" is not a cookie name.`);
  return { locales, defaultLocale, localeCookie };
}

function normalizeMarkets(config: MarketConfig): NormalizedMarkets {
  let markets: string[] | null = null;
  if (config.markets) {
    markets = config.markets.map((code) => code.toUpperCase());
    for (const code of markets) {
      if (!COUNTRY.test(code) || UNKNOWN_COUNTRIES.has(code)) throw new Error(`LocaleConfig.markets: "${code}" is not a country code.`);
    }
  }
  let defaultMarket: string | null = null;
  if (config.defaultMarket) {
    defaultMarket = config.defaultMarket.toUpperCase();
    if (!COUNTRY.test(defaultMarket) || UNKNOWN_COUNTRIES.has(defaultMarket)) {
      throw new Error(`LocaleConfig.defaultMarket "${config.defaultMarket}" is not a country code.`);
    }
    if (markets && !markets.includes(defaultMarket)) throw new Error(`LocaleConfig.defaultMarket "${config.defaultMarket}" is not in markets.`);
  } else if (markets) {
    throw new Error('LocaleConfig.defaultMarket is required when markets is set.');
  }
  const marketCookie = config.cookie?.market ?? DEFAULT_MARKET_COOKIE;
  if (!COOKIE_NAME.test(marketCookie)) throw new Error(`LocaleConfig.cookie: "${marketCookie}" is not a cookie name.`);
  return { markets, defaultMarket, marketCookie };
}

function primary(tag: string): string {
  return tag.split('-')[0].toLowerCase();
}

/** Parse an `Accept-Language` header into tags ordered by quality, keeping header order among equals. */
export function parseAcceptLanguage(header: string | null | undefined): Array<{ tag: string; q: number }> {
  if (!header) return [];
  const entries: Array<{ tag: string; q: number }> = [];
  for (const part of header.slice(0, MAX_ACCEPT_LANGUAGE).split(',').slice(0, MAX_ACCEPT_ENTRIES)) {
    const [rawTag, ...params] = part.split(';').map((piece) => piece.trim());
    if (rawTag !== '*' && !TAG.test(rawTag)) continue;
    let q = 1;
    let valid = true;
    for (const param of params) {
      if (!/^q=/i.test(param)) continue;
      const match = /^q=(\d(?:\.\d{0,3})?)$/i.exec(param);
      q = match ? Number(match[1]) : NaN;
      if (!(q >= 0 && q <= 1)) valid = false;
    }
    if (valid) entries.push({ tag: rawTag, q });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.q - a.entry.q || a.index - b.index)
    .map(({ entry }) => entry);
}

function matchLocale(tag: string, locales: readonly string[]): string | undefined {
  const lower = tag.toLowerCase();
  const exact = locales.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const language = primary(tag);
  const sameLanguage = locales.filter((locale) => primary(locale) === language);
  return sameLanguage.find((locale) => locale.toLowerCase() === language) ?? sameLanguage[0];
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function normalizeCountry(value: string | null | undefined): string | undefined {
  const code = value?.trim().toUpperCase();
  return code && COUNTRY.test(code) && !UNKNOWN_COUNTRIES.has(code) ? code : undefined;
}

/** Split a leading language prefix off a path: `/da/shop` gives `{ locale: 'da', path: '/shop' }`. */
export function splitLocalePath(path: string, config: LocaleConfig): { locale?: string; path: string } {
  const { locales } = normalizeLocales(config);
  return splitPath(path, locales);
}

function splitPath(path: string, locales: readonly string[]): { locale?: string; path: string } {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const [, first = '', ...rest] = clean.split('/');
  const locale = locales.find((tag) => tag.toLowerCase() === first.toLowerCase());
  if (!locale) return { path: clean };
  return { locale, path: `/${rest.join('/')}` };
}

/** Prefix a path with a language, replacing a prefix it already has. The root is `/da`, not `/da/`. */
export function localizedPath(path: string, locale: string, config: LocaleConfig): string {
  const { locales } = normalizeLocales(config);
  const tag = locales.find((candidate) => candidate.toLowerCase() === locale.toLowerCase());
  if (!tag) throw new RangeError(`"${locale}" is not one of the configured locales.`);
  const { path: bare } = splitPath(path, locales);
  return bare === '/' ? `/${tag}` : `/${tag}${bare}`;
}

/**
 * The `<link rel="alternate" hreflang>` entries for a page, one per language plus `x-default` for the default
 * language. `path` is the page's path with or without a language prefix, without a query string.
 */
export function hreflangLinks(path: string, siteUrl: string, config: LocaleConfig): Array<{ hreflang: string; href: string }> {
  const { locales, defaultLocale } = normalizeLocales(config);
  const href = (locale: string) => new URL(localizedPath(path, locale, config), siteUrl).toString();
  return [
    ...locales.map((locale) => ({ hreflang: locale, href: href(locale) })),
    { hreflang: 'x-default', href: href(defaultLocale) },
  ];
}

/**
 * A `Set-Cookie` value for the visitor's language or market choice. The cookie is readable by scripts, lasts a
 * year and is not sent cross-site. `secure` defaults to true; turn it off only for plain-HTTP local development.
 */
export function localeCookie(name: string, value: string, opts: { secure?: boolean; maxAge?: number } = {}): string {
  if (!COOKIE_NAME.test(name)) throw new Error(`"${name}" is not a cookie name.`);
  if (!COOKIE_VALUE.test(value)) throw new Error(`"${value}" is not a cookie value.`);
  const attributes = [`${name}=${value}`, 'Path=/', `Max-Age=${opts.maxAge ?? 31_536_000}`, 'SameSite=Lax'];
  if (opts.secure !== false) attributes.push('Secure');
  return attributes.join('; ');
}

function isCrawler(request: Request, opts: ResolveLocaleOptions): boolean {
  return opts.crawler ?? CRAWLER_AGENT.test(request.headers.get('user-agent') ?? '');
}

function pickMarket(request: Request, settings: NormalizedMarkets, opts: ResolveLocaleOptions, crawler: boolean): ResolvedMarket {
  if (!crawler) {
    const allowed = (code: string | undefined) => (code && (!settings.markets || settings.markets.includes(code)) ? code : undefined);
    const cookie = allowed(normalizeCountry(readCookie(request.headers.get('cookie'), settings.marketCookie)));
    if (cookie) return { market: cookie, source: 'cookie' };
    const geo = allowed(normalizeCountry(opts.country ?? request.headers.get('cf-ipcountry')));
    if (geo) return { market: geo, source: 'geo' };
  }
  return { market: settings.defaultMarket, source: 'default' };
}

/**
 * Resolve the visitor's market: the market cookie, then the country, then the default. With `markets` set, a
 * country outside it falls back to the default; crawlers always get the default. For a site with one language,
 * or one that settles its language elsewhere: it never redirects and reads no language.
 */
export function resolveMarket(request: Request, config: MarketConfig, opts: ResolveLocaleOptions = {}): ResolvedMarket {
  return pickMarket(request, normalizeMarkets(config), opts, isCrawler(request, opts));
}

/**
 * Resolve the language and market for a request.
 *
 * Language: the path prefix, then the visitor's cookie, then `Accept-Language`, then the default. Market: as
 * `resolveMarket`. Crawlers get the default language and market and are never redirected.
 *
 * `redirectTo` is set for a GET or HEAD request to a path without a language prefix, so every language has its
 * own cacheable URL. Call this only for page routes: leave assets, the admin and the API alone.
 */
export function resolveLocale(request: Request, config: LocaleConfig, opts: ResolveLocaleOptions = {}): ResolvedLocale {
  const settings = normalizeLocales(config);
  const markets = normalizeMarkets(config);
  const url = new URL(request.url);
  const headers = request.headers;
  const crawler = isCrawler(request, opts);
  const cookies = headers.get('cookie');

  const fromPath = splitPath(url.pathname, settings.locales).locale;
  let locale = settings.defaultLocale;
  let localeSource: ResolvedLocale['source']['locale'] = 'default';
  if (fromPath) {
    locale = fromPath;
    localeSource = 'path';
  } else if (!crawler) {
    const cookie = matchCookieLocale(readCookie(cookies, settings.localeCookie), settings.locales);
    if (cookie) {
      locale = cookie;
      localeSource = 'cookie';
    } else {
      for (const { tag, q } of parseAcceptLanguage(headers.get('accept-language'))) {
        const match = q > 0 && tag !== '*' ? matchLocale(tag, settings.locales) : undefined;
        if (match) {
          locale = match;
          localeSource = 'header';
          break;
        }
      }
    }
  }

  const { market, source: marketSource } = pickMarket(request, markets, opts, crawler);
  const resolved: ResolvedLocale = { locale, market, source: { locale: localeSource, market: marketSource } };
  if (!fromPath && !crawler && (request.method === 'GET' || request.method === 'HEAD')) {
    resolved.redirectTo = `${localizedPath(url.pathname, locale, config)}${url.search}`;
  }
  return resolved;
}

function matchCookieLocale(value: string | undefined, locales: readonly string[]): string | undefined {
  return value ? locales.find((tag) => tag.toLowerCase() === value.toLowerCase()) : undefined;
}
