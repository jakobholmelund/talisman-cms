import "./chunk-MLKGABMK.js";

// src/locale.ts
var DEFAULT_LOCALE_COOKIE = "talisman-locale";
var DEFAULT_MARKET_COOKIE = "talisman-market";
var TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
var COUNTRY = /^[A-Z]{2}$/;
var UNKNOWN_COUNTRIES = /* @__PURE__ */ new Set(["XX", "T1"]);
var COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
var COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;
var CRAWLER_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram/i;
var MAX_ACCEPT_LANGUAGE = 1e3;
var MAX_ACCEPT_ENTRIES = 32;
function normalizeLocales(config) {
  const locales = [...config.locales];
  if (!locales.length) throw new Error("LocaleConfig.locales needs at least one language.");
  const seen = /* @__PURE__ */ new Set();
  for (const tag of locales) {
    if (!TAG.test(tag)) throw new Error(`LocaleConfig.locales: "${tag}" is not a language tag.`);
    if (seen.has(tag.toLowerCase())) throw new Error(`LocaleConfig.locales: "${tag}" is listed twice.`);
    seen.add(tag.toLowerCase());
  }
  const defaultLocale = locales.find((tag) => tag.toLowerCase() === config.defaultLocale?.toLowerCase());
  if (!defaultLocale) throw new Error(`LocaleConfig.defaultLocale "${config.defaultLocale}" is not in locales.`);
  const localeCookie2 = config.cookie?.locale ?? DEFAULT_LOCALE_COOKIE;
  if (!COOKIE_NAME.test(localeCookie2)) throw new Error(`LocaleConfig.cookie: "${localeCookie2}" is not a cookie name.`);
  return { locales, defaultLocale, localeCookie: localeCookie2 };
}
function normalizeMarkets(config) {
  let markets = null;
  if (config.markets) {
    markets = config.markets.map((code) => code.toUpperCase());
    for (const code of markets) {
      if (!COUNTRY.test(code) || UNKNOWN_COUNTRIES.has(code)) throw new Error(`LocaleConfig.markets: "${code}" is not a country code.`);
    }
  }
  let defaultMarket = null;
  if (config.defaultMarket) {
    defaultMarket = config.defaultMarket.toUpperCase();
    if (!COUNTRY.test(defaultMarket) || UNKNOWN_COUNTRIES.has(defaultMarket)) {
      throw new Error(`LocaleConfig.defaultMarket "${config.defaultMarket}" is not a country code.`);
    }
    if (markets && !markets.includes(defaultMarket)) throw new Error(`LocaleConfig.defaultMarket "${config.defaultMarket}" is not in markets.`);
  } else if (markets) {
    throw new Error("LocaleConfig.defaultMarket is required when markets is set.");
  }
  const marketCookie = config.cookie?.market ?? DEFAULT_MARKET_COOKIE;
  if (!COOKIE_NAME.test(marketCookie)) throw new Error(`LocaleConfig.cookie: "${marketCookie}" is not a cookie name.`);
  return { markets, defaultMarket, marketCookie };
}
function primary(tag) {
  return tag.split("-")[0].toLowerCase();
}
function parseAcceptLanguage(header) {
  if (!header) return [];
  const entries = [];
  for (const part of header.slice(0, MAX_ACCEPT_LANGUAGE).split(",").slice(0, MAX_ACCEPT_ENTRIES)) {
    const [rawTag, ...params] = part.split(";").map((piece) => piece.trim());
    if (rawTag !== "*" && !TAG.test(rawTag)) continue;
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
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.q - a.entry.q || a.index - b.index).map(({ entry }) => entry);
}
function matchLocale(tag, locales) {
  const lower = tag.toLowerCase();
  const exact = locales.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const language = primary(tag);
  const sameLanguage = locales.filter((locale) => primary(locale) === language);
  return sameLanguage.find((locale) => locale.toLowerCase() === language) ?? sameLanguage[0];
}
function readCookie(header, name) {
  if (!header) return void 0;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return void 0;
}
function normalizeCountry(value) {
  const code = value?.trim().toUpperCase();
  return code && COUNTRY.test(code) && !UNKNOWN_COUNTRIES.has(code) ? code : void 0;
}
function splitLocalePath(path, config) {
  const { locales } = normalizeLocales(config);
  return splitPath(path, locales);
}
function splitPath(path, locales) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const [, first = "", ...rest] = clean.split("/");
  const locale = locales.find((tag) => tag.toLowerCase() === first.toLowerCase());
  if (!locale) return { path: clean };
  return { locale, path: `/${rest.join("/")}` };
}
function localizedPath(path, locale, config) {
  const { locales } = normalizeLocales(config);
  const tag = locales.find((candidate) => candidate.toLowerCase() === locale.toLowerCase());
  if (!tag) throw new RangeError(`"${locale}" is not one of the configured locales.`);
  const { path: bare } = splitPath(path, locales);
  return bare === "/" ? `/${tag}` : `/${tag}${bare}`;
}
function hreflangLinks(path, siteUrl, config) {
  const { locales, defaultLocale } = normalizeLocales(config);
  const href = (locale) => new URL(localizedPath(path, locale, config), siteUrl).toString();
  return [
    ...locales.map((locale) => ({ hreflang: locale, href: href(locale) })),
    { hreflang: "x-default", href: href(defaultLocale) }
  ];
}
function localeCookie(name, value, opts = {}) {
  if (!COOKIE_NAME.test(name)) throw new Error(`"${name}" is not a cookie name.`);
  if (!COOKIE_VALUE.test(value)) throw new Error(`"${value}" is not a cookie value.`);
  const attributes = [`${name}=${value}`, "Path=/", `Max-Age=${opts.maxAge ?? 31536e3}`, "SameSite=Lax"];
  if (opts.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}
function isCrawler(request, opts) {
  return opts.crawler ?? CRAWLER_AGENT.test(request.headers.get("user-agent") ?? "");
}
function pickMarket(request, settings, opts, crawler) {
  if (!crawler) {
    const allowed = (code) => code && (!settings.markets || settings.markets.includes(code)) ? code : void 0;
    const cookie = allowed(normalizeCountry(readCookie(request.headers.get("cookie"), settings.marketCookie)));
    if (cookie) return { market: cookie, source: "cookie" };
    const geo = allowed(normalizeCountry(opts.country ?? request.headers.get("cf-ipcountry")));
    if (geo) return { market: geo, source: "geo" };
  }
  return { market: settings.defaultMarket, source: "default" };
}
function resolveMarket(request, config, opts = {}) {
  return pickMarket(request, normalizeMarkets(config), opts, isCrawler(request, opts));
}
function resolveLocale(request, config, opts = {}) {
  const settings = normalizeLocales(config);
  const markets = normalizeMarkets(config);
  const url = new URL(request.url);
  const headers = request.headers;
  const crawler = isCrawler(request, opts);
  const cookies = headers.get("cookie");
  const fromPath = splitPath(url.pathname, settings.locales).locale;
  let locale = settings.defaultLocale;
  let localeSource = "default";
  if (fromPath) {
    locale = fromPath;
    localeSource = "path";
  } else if (!crawler) {
    const cookie = matchCookieLocale(readCookie(cookies, settings.localeCookie), settings.locales);
    if (cookie) {
      locale = cookie;
      localeSource = "cookie";
    } else {
      for (const { tag, q } of parseAcceptLanguage(headers.get("accept-language"))) {
        const match = q > 0 && tag !== "*" ? matchLocale(tag, settings.locales) : void 0;
        if (match) {
          locale = match;
          localeSource = "header";
          break;
        }
      }
    }
  }
  const { market, source: marketSource } = pickMarket(request, markets, opts, crawler);
  const resolved = { locale, market, source: { locale: localeSource, market: marketSource } };
  if (!fromPath && !crawler && (request.method === "GET" || request.method === "HEAD")) {
    resolved.redirectTo = `${localizedPath(url.pathname, locale, config)}${url.search}`;
  }
  return resolved;
}
function matchCookieLocale(value, locales) {
  return value ? locales.find((tag) => tag.toLowerCase() === value.toLowerCase()) : void 0;
}
export {
  DEFAULT_LOCALE_COOKIE,
  DEFAULT_MARKET_COOKIE,
  hreflangLinks,
  localeCookie,
  localizedPath,
  parseAcceptLanguage,
  resolveLocale,
  resolveMarket,
  splitLocalePath
};
