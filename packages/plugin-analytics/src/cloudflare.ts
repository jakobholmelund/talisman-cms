export type PeriodDays = 7 | 30;

export function parsePeriod(value: string | null): PeriodDays {
  return value === '30' ? 30 : 7;
}

export function periodBounds(days: PeriodDays, now = new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

type RumGroup = {
  count?: number;
  sum?: { visits?: number };
  dimensions?: { date?: string; requestPath?: string; refererHost?: string; countryName?: string };
};
type VitalGroup = {
  quantiles?: {
    largestContentfulPaintP75?: number;
    interactionToNextPaintP75?: number;
    cumulativeLayoutShiftP75?: number;
  };
};

export type TrafficOverview = {
  periodDays: PeriodDays;
  start: string;
  end: string;
  pageViews: number;
  visits: number;
  trend: Array<{ date: string; pageViews: number; visits: number }>;
  pages: Array<{ path: string; pageViews: number; visits: number; editHref?: string }>;
  referrers: Array<{ host: string; visits: number }>;
  countries: Array<{ country: string; visits: number }>;
  vitals: { lcpP75Ms: number | null; inpP75Ms: number | null; clsP75: number | null } | null;
  vitalsError?: string;
};
export type TrafficRange = Omit<TrafficOverview, 'periodDays'>;

const hexTag = /^[a-f0-9]{32}$/i;

export function analyticsCredentials(env: Record<string, unknown>) {
  const account = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID;
  const site = env.CLOUDFLARE_ANALYTICS_SITE_TAG;
  const token = env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (typeof account !== 'string' || !hexTag.test(account) ||
      typeof site !== 'string' || !hexTag.test(site) ||
      typeof token !== 'string' || !token.trim()) {
    throw new Error('Set CLOUDFLARE_ANALYTICS_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_SITE_TAG, and CLOUDFLARE_ANALYTICS_API_TOKEN in Worker bindings.');
  }
  return { account, site, token };
}

export function trafficQuery(account: string, site: string, start: string, end: string) {
  const filter = `filter: { siteTag: ${JSON.stringify(site)}, datetime_geq: ${JSON.stringify(start)}, datetime_lt: ${JSON.stringify(end)} }`;
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    total: rumPageloadEventsAdaptiveGroups(${filter}, limit: 1) { count sum { visits } }
    trend: rumPageloadEventsAdaptiveGroups(${filter}, limit: 31, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
    pages: rumPageloadEventsAdaptiveGroups(${filter}, limit: 20, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
    referrers: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(${filter}, limit: 10, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
  } } }`;
}

export function vitalsQuery(account: string, site: string, start: string, end: string) {
  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(account)} }) {
    vitals: rumWebVitalsEventsAdaptiveGroups(filter: { siteTag: ${JSON.stringify(site)}, datetime_geq: ${JSON.stringify(start)}, datetime_lt: ${JSON.stringify(end)} }, limit: 1) {
      quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 }
    }
  } } }`;
}

async function queryCloudflare<T>(token: string, query: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || json.errors?.length || !json.data) {
    const detail = json.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Cloudflare Analytics query failed: ${detail}`);
  }
  return json.data;
}

function finite(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function vital(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function fetchTrafficRange(
  env: Record<string, unknown>, start: string, end: string, fetcher: typeof fetch = fetch
): Promise<TrafficRange> {
  const { account, site, token } = analyticsCredentials(env);
  type TrafficResponse = { viewer: { accounts: Array<{
    total: RumGroup[]; trend: RumGroup[]; pages: RumGroup[]; referrers: RumGroup[]; countries: RumGroup[];
  }> } };
  const data = await queryCloudflare<TrafficResponse>(token, trafficQuery(account, site, start, end), fetcher);
  const rows = data.viewer.accounts[0];
  if (!rows) throw new Error('Cloudflare Analytics returned no account data. Check the account ID and token permissions.');
  const overview: TrafficRange = {
    start, end,
    pageViews: finite(rows.total?.[0]?.count), visits: finite(rows.total?.[0]?.sum?.visits),
    trend: (rows.trend || []).filter(row => row.dimensions?.date).map(row => ({
      date: row.dimensions!.date!, pageViews: finite(row.count), visits: finite(row.sum?.visits)
    })),
    pages: (rows.pages || []).filter(row => row.dimensions?.requestPath).map(row => ({
      path: row.dimensions!.requestPath!, pageViews: finite(row.count), visits: finite(row.sum?.visits)
    })),
    referrers: (rows.referrers || []).map(row => ({ host: row.dimensions?.refererHost || 'Direct / unknown', visits: finite(row.sum?.visits) })),
    countries: (rows.countries || []).map(row => ({ country: row.dimensions?.countryName || 'Unknown', visits: finite(row.sum?.visits) })),
    vitals: null,
  };
  try {
    const performance = await queryCloudflare<{ viewer: { accounts: Array<{ vitals: VitalGroup[] }> } }>(
      token, vitalsQuery(account, site, start, end), fetcher
    );
    const quantiles = performance.viewer.accounts[0]?.vitals?.[0]?.quantiles;
    if (quantiles) overview.vitals = {
      lcpP75Ms: vital(quantiles.largestContentfulPaintP75) === null ? null : quantiles.largestContentfulPaintP75! / 1000,
      inpP75Ms: vital(quantiles.interactionToNextPaintP75) === null ? null : quantiles.interactionToNextPaintP75! / 1000,
      clsP75: vital(quantiles.cumulativeLayoutShiftP75),
    };
  } catch (error) {
    overview.vitalsError = error instanceof Error ? error.message : 'Core Web Vitals unavailable';
  }
  return overview;
}

export async function fetchTrafficOverview(
  env: Record<string, unknown>, days: PeriodDays, fetcher: typeof fetch = fetch, now = new Date()
): Promise<TrafficOverview> {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchTrafficRange(env, start, end, fetcher) };
}
