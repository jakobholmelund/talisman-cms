// src/cloudflare.ts
function parsePeriod(value) {
  return value === "30" ? 30 : 7;
}
function periodBounds(days, now = /* @__PURE__ */ new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 864e5);
  return { start: start.toISOString(), end: end.toISOString() };
}
var hexTag = /^[a-f0-9]{32}$/i;
function analyticsCredentials(env) {
  const account = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID;
  const site = env.CLOUDFLARE_ANALYTICS_SITE_TAG;
  const token = env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (typeof account !== "string" || !hexTag.test(account) || typeof site !== "string" || !hexTag.test(site) || typeof token !== "string" || !token.trim()) {
    throw new Error("Set CLOUDFLARE_ANALYTICS_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_SITE_TAG, and CLOUDFLARE_ANALYTICS_API_TOKEN in Worker bindings.");
  }
  return { account, site, token };
}
function trafficQuery(account, site, start, end) {
  const filter = `filter: { siteTag: ${JSON.stringify(site)}, datetime_geq: ${JSON.stringify(start)}, datetime_lt: ${JSON.stringify(end)} }`;
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    total: rumPageloadEventsAdaptiveGroups(${filter}, limit: 1) { count sum { visits } }
    trend: rumPageloadEventsAdaptiveGroups(${filter}, limit: 31, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
    pages: rumPageloadEventsAdaptiveGroups(${filter}, limit: 20, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
    referrers: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
  } } }`;
}
function vitalsQuery(account, site, start, end) {
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    vitals: rumWebVitalsEventsAdaptiveGroups(filter: { siteTag: ${JSON.stringify(site)}, datetime_geq: ${JSON.stringify(start)}, datetime_lt: ${JSON.stringify(end)} }, limit: 1) {
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
    const detail = json.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Cloudflare Analytics query failed: ${detail}`);
  }
  return json.data;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function vital(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
async function fetchTrafficRange(env, start, end, fetcher = fetch) {
  const { account, site, token } = analyticsCredentials(env);
  const data = await queryCloudflare(token, trafficQuery(account, site, start, end), fetcher);
  const rows = data.viewer.accounts[0];
  if (!rows) throw new Error("Cloudflare Analytics returned no account data. Check the account ID and token permissions.");
  const overview = {
    start,
    end,
    pageViews: finite(rows.total?.[0]?.count),
    visits: finite(rows.total?.[0]?.sum?.visits),
    trend: (rows.trend || []).filter((row) => row.dimensions?.date).map((row) => ({
      date: row.dimensions.date,
      pageViews: finite(row.count),
      visits: finite(row.sum?.visits)
    })),
    pages: (rows.pages || []).filter((row) => row.dimensions?.requestPath).map((row) => ({
      path: row.dimensions.requestPath,
      pageViews: finite(row.count),
      visits: finite(row.sum?.visits)
    })),
    referrers: (rows.referrers || []).map((row) => ({ host: row.dimensions?.refererHost || "Direct / unknown", visits: finite(row.sum?.visits) })),
    countries: (rows.countries || []).map((row) => ({ country: row.dimensions?.countryName || "Unknown", visits: finite(row.sum?.visits) })),
    vitals: null
  };
  try {
    const performance = await queryCloudflare(
      token,
      vitalsQuery(account, site, start, end),
      fetcher
    );
    const quantiles = performance.viewer.accounts[0]?.vitals?.[0]?.quantiles;
    if (quantiles) overview.vitals = {
      lcpP75Ms: vital(quantiles.largestContentfulPaintP75) === null ? null : quantiles.largestContentfulPaintP75 / 1e3,
      inpP75Ms: vital(quantiles.interactionToNextPaintP75) === null ? null : quantiles.interactionToNextPaintP75 / 1e3,
      clsP75: vital(quantiles.cumulativeLayoutShiftP75)
    };
  } catch (error) {
    overview.vitalsError = error instanceof Error ? error.message : "Core Web Vitals unavailable";
  }
  return overview;
}
async function fetchTrafficOverview(env, days, fetcher = fetch, now = /* @__PURE__ */ new Date()) {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchTrafficRange(env, start, end, fetcher) };
}

export {
  parsePeriod,
  periodBounds,
  analyticsCredentials,
  trafficQuery,
  vitalsQuery,
  fetchTrafficRange,
  fetchTrafficOverview
};
