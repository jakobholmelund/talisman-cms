// src/admin/dates.ts
var day = 864e5;
function formatRange(start, end, locale) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const date = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
  if (from % day === 0 && to % day === 0) {
    const first = date.format(from);
    const last = date.format(Math.max(from, to - 1));
    return first === last ? `${first} UTC` : `${first}\u2013${last} UTC`;
  }
  const time = new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const firstDay = date.format(from);
  const lastDay = date.format(to);
  return firstDay === lastDay ? `${firstDay}, ${time.format(from)}\u2013${time.format(to)} UTC` : `${firstDay}, ${time.format(from)} \u2013 ${lastDay}, ${time.format(to)} UTC`;
}
function dailyDates(start, end) {
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const dates = [];
  for (let time = Math.floor(from / day) * day; time < to && dates.length < 366; time += day) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

// src/cloudflare.ts
function parsePeriod(value) {
  return value === "30" ? 30 : 7;
}
function periodBounds(days, now = /* @__PURE__ */ new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 864e5);
  return { start: start.toISOString(), end: end.toISOString() };
}
var AnalyticsSetupError = class extends Error {
};
var hexTag = /^[a-f0-9]{32}$/i;
function analyticsCredentials(env) {
  const account = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID;
  const site = env.CLOUDFLARE_ANALYTICS_SITE_TAG;
  const token = env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (typeof account !== "string" || !hexTag.test(account) || typeof site !== "string" || !hexTag.test(site) || typeof token !== "string" || !token.trim()) {
    throw new AnalyticsSetupError("Set CLOUDFLARE_ANALYTICS_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_SITE_TAG, and CLOUDFLARE_ANALYTICS_API_TOKEN in Worker bindings.");
  }
  return { account, site, token };
}
function trafficFilter(site, start, end, adminBase = "/admin") {
  const paths = [.../* @__PURE__ */ new Set(["/api", adminBase.replace(/\/$/, "")])];
  const excluded = paths.map((path) => `{ requestPath_neq: ${JSON.stringify(path)}, OR: [{ requestPath_lt: ${JSON.stringify(path + "/")} }, { requestPath_geq: ${JSON.stringify(path + "0")} }] }`).join(", ");
  return `filter: { siteTag: ${JSON.stringify(site)}, datetime_geq: ${JSON.stringify(start)}, datetime_lt: ${JSON.stringify(end)}, AND: [${excluded}] }`;
}
function trafficQuery(account, site, start, end, adminBase = "/admin") {
  const filter = trafficFilter(site, start, end, adminBase);
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    total: rumPageloadEventsAdaptiveGroups(${filter}, limit: 1) { count sum { visits } }
    trend: rumPageloadEventsAdaptiveGroups(${filter}, limit: 31, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
    pages: rumPageloadEventsAdaptiveGroups(${filter}, limit: 20, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
    referrers: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
  } } }`;
}
function vitalsQuery(account, site, start, end, adminBase = "/admin") {
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    vitals: rumWebVitalsEventsAdaptiveGroups(${trafficFilter(site, start, end, adminBase)}, limit: 1) {
      quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 }
    }
  } } }`;
}
async function queryCloudflare(token, query, fetcher) {
  const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(1e4)
  });
  const json = await response.json();
  if (!response.ok || json.errors?.length || !json.data) {
    throw new Error("Cloudflare Analytics is unavailable. Check token permissions or try again later.");
  }
  return json.data;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function vital(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
async function fetchTrafficRange(env, start, end, fetcher = fetch, adminBase = "/admin", includeVitals = true) {
  const { account, site, token } = analyticsCredentials(env);
  const data = await queryCloudflare(token, trafficQuery(account, site, start, end, adminBase), fetcher);
  const rows = data.viewer.accounts[0];
  if (!rows) throw new AnalyticsSetupError("Cloudflare Analytics returned no account data. Check the account ID and token permissions.");
  const overview = {
    start,
    end,
    pageViews: finite(rows.total?.[0]?.count),
    visits: finite(rows.total?.[0]?.sum?.visits),
    trend: dailyDates(start, end).map((date) => {
      const row = rows.trend?.find((row2) => row2.dimensions?.date === date);
      return { date, pageViews: finite(row?.count), visits: finite(row?.sum?.visits) };
    }),
    pages: (rows.pages || []).filter((row) => row.dimensions?.requestPath).map((row) => ({
      path: row.dimensions.requestPath,
      pageViews: finite(row.count),
      visits: finite(row.sum?.visits)
    })),
    referrers: (rows.referrers || []).map((row) => ({ host: row.dimensions?.refererHost || "Direct / unknown", visits: finite(row.sum?.visits) })),
    countries: (rows.countries || []).map((row) => ({ country: row.dimensions?.countryName || "Unknown", visits: finite(row.sum?.visits) })),
    vitals: null
  };
  if (!includeVitals) return overview;
  try {
    const performance = await queryCloudflare(
      token,
      vitalsQuery(account, site, start, end, adminBase),
      fetcher
    );
    const quantiles = performance.viewer.accounts[0]?.vitals?.[0]?.quantiles;
    if (quantiles) overview.vitals = {
      lcpP75Ms: vital(quantiles.largestContentfulPaintP75) === null ? null : quantiles.largestContentfulPaintP75 / 1e3,
      inpP75Ms: vital(quantiles.interactionToNextPaintP75) === null ? null : quantiles.interactionToNextPaintP75 / 1e3,
      clsP75: vital(quantiles.cumulativeLayoutShiftP75)
    };
  } catch (error) {
    overview.vitalsError = "Core Web Vitals are unavailable. Check Cloudflare permissions or try again later.";
  }
  return overview;
}
async function fetchTrafficOverview(env, days, fetcher = fetch, now = /* @__PURE__ */ new Date(), adminBase = "/admin") {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchTrafficRange(env, start, end, fetcher, adminBase) };
}

export {
  formatRange,
  dailyDates,
  parsePeriod,
  periodBounds,
  AnalyticsSetupError,
  analyticsCredentials,
  trafficFilter,
  trafficQuery,
  vitalsQuery,
  fetchTrafficRange,
  fetchTrafficOverview
};
