/**
 * Language and market resolution for a localized site.
 *
 * Pure functions over a `Request` and a `LocaleConfig`: nothing here reads a binding or the network. The
 * visitor's country is an argument (`opts.country`, from `request.cf.country` in a Worker), which keeps the
 * helpers testable without Cloudflare. Language and market are separate: the language says which text to
 * render and comes from the URL, the visitor's choice or `Accept-Language`, never from geography; the market
 * says which country's currency, delivery and tax apply and may come from the country.
 */
declare const DEFAULT_LOCALE_COOKIE = "talisman-locale";
declare const DEFAULT_MARKET_COOKIE = "talisman-market";
interface MarketConfig {
    /** ISO 3166-1 alpha-2 codes the site sells to. Omit to accept any country. */
    markets?: readonly string[];
    /** Used when the visitor's market is unknown or not in `markets`. Required when `markets` is set, and must be one of them. */
    defaultMarket?: string;
    cookie?: {
        market?: string;
    };
}
interface LocaleConfig extends MarketConfig {
    /** Supported language tags, such as `['da', 'en']`. Each gets its own URL prefix. */
    locales: readonly string[];
    /** Used when nothing else picks a language, and for crawlers. Must be one of `locales`. */
    defaultLocale: string;
    cookie?: {
        locale?: string;
        market?: string;
    };
}
interface ResolveLocaleOptions {
    /** The visitor's country (`request.cf.country`). The `CF-IPCountry` header is read when this is missing. */
    country?: string | null;
    /** Set for a verified crawler (`request.cf.botManagement.verifiedBot`); the user agent decides otherwise. */
    crawler?: boolean;
}
interface ResolvedMarket {
    /** The market's country code, or null when nothing resolved one and the config has no default. */
    market: string | null;
    source: 'cookie' | 'geo' | 'default';
}
interface ResolvedLocale {
    locale: string;
    market: ResolvedMarket['market'];
    source: {
        locale: 'path' | 'cookie' | 'header' | 'default';
        market: ResolvedMarket['source'];
    };
    /** Set for a GET or HEAD request to a path without a language prefix; answer it with a redirect (302). */
    redirectTo?: string;
}
/** Parse an `Accept-Language` header into tags ordered by quality, keeping header order among equals. */
declare function parseAcceptLanguage(header: string | null | undefined): Array<{
    tag: string;
    q: number;
}>;
/** Split a leading language prefix off a path: `/da/shop` gives `{ locale: 'da', path: '/shop' }`. */
declare function splitLocalePath(path: string, config: LocaleConfig): {
    locale?: string;
    path: string;
};
/** Prefix a path with a language, replacing a prefix it already has. The root is `/da`, not `/da/`. */
declare function localizedPath(path: string, locale: string, config: LocaleConfig): string;
/**
 * The `<link rel="alternate" hreflang>` entries for a page, one per language plus `x-default` for the default
 * language. `path` is the page's path with or without a language prefix, without a query string.
 */
declare function hreflangLinks(path: string, siteUrl: string, config: LocaleConfig): Array<{
    hreflang: string;
    href: string;
}>;
/**
 * A `Set-Cookie` value for the visitor's language or market choice. The cookie is readable by scripts, lasts a
 * year and is not sent cross-site. `secure` defaults to true; turn it off only for plain-HTTP local development.
 */
declare function localeCookie(name: string, value: string, opts?: {
    secure?: boolean;
    maxAge?: number;
}): string;
/**
 * Resolve the visitor's market: the market cookie, then the country, then the default. With `markets` set, a
 * country outside it falls back to the default; crawlers always get the default. For a site with one language,
 * or one that settles its language elsewhere: it never redirects and reads no language.
 */
declare function resolveMarket(request: Request, config: MarketConfig, opts?: ResolveLocaleOptions): ResolvedMarket;
/**
 * Resolve the language and market for a request.
 *
 * Language: the path prefix, then the visitor's cookie, then `Accept-Language`, then the default. Market: as
 * `resolveMarket`. Crawlers get the default language and market and are never redirected.
 *
 * `redirectTo` is set for a GET or HEAD request to a path without a language prefix, so every language has its
 * own cacheable URL. Call this only for page routes: leave assets, the admin and the API alone.
 */
declare function resolveLocale(request: Request, config: LocaleConfig, opts?: ResolveLocaleOptions): ResolvedLocale;

export { DEFAULT_LOCALE_COOKIE, DEFAULT_MARKET_COOKIE, type LocaleConfig, type MarketConfig, type ResolveLocaleOptions, type ResolvedLocale, type ResolvedMarket, hreflangLinks, localeCookie, localizedPath, parseAcceptLanguage, resolveLocale, resolveMarket, splitLocalePath };
