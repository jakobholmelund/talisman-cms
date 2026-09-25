import React, { useEffect, useState } from 'react';
import { analyticsRequest, Metric, number, Panel, RangePicker, Trend } from './common';
import type { TrafficOverview } from '../cloudflare';

export default function Analytics() {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<TrafficOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    void analyticsRequest<TrafficOverview>('overview', days, controller.signal)
      .then(setData)
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Analytics unavailable'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days]);

  return <div className="talisman-analytics">
    <div className="talisman-analytics__toolbar"><p>Cloudflare Web Analytics traffic and browser performance.</p><RangePicker days={days} onChange={setDays} /></div>
    {loading && <p role="status">Loading analytics…</p>}
    {error && <p className="talisman-analytics__error" role="alert">{error}</p>}
    {data && !loading && <>
      <div className="talisman-analytics__metrics">
        <Metric label="Page views" value={number(data.pageViews)} detail="Reported by Cloudflare" />
        <Metric label="Visits" value={number(data.visits)} detail="External referrals or direct visits" />
        <Metric label="LCP p75" value={data.vitals?.lcpP75Ms == null ? '—' : `${Math.round(data.vitals.lcpP75Ms)} ms`} detail="Largest Contentful Paint" />
        <Metric label="INP p75" value={data.vitals?.inpP75Ms == null ? '—' : `${Math.round(data.vitals.inpP75Ms)} ms`} detail="Interaction to Next Paint" />
        <Metric label="CLS p75" value={data.vitals?.clsP75 == null ? '—' : data.vitals.clsP75.toFixed(3)} detail="Cumulative Layout Shift" />
      </div>
      {data.vitalsError && <p className="talisman-analytics__muted">Core Web Vitals unavailable: {data.vitalsError}</p>}
      <Panel title="Page views by day">
        {data.trend.length ? <Trend points={data.trend} value="pageViews" label="Daily page views" /> : <p className="talisman-analytics__muted">No traffic recorded in this period.</p>}
      </Panel>
      <div className="talisman-analytics__columns">
        <Panel title="Top pages">
          <div className="talisman-analytics__list">
            {data.pages.map(page => <div key={page.path} className="talisman-analytics__row">
              <span><code>{page.path}</code>{page.editHref && <a href={page.editHref}>Edit page</a>}</span>
              <strong>{number(page.pageViews)}</strong>
            </div>)}
            {!data.pages.length && <p className="talisman-analytics__muted">No page data yet.</p>}
          </div>
        </Panel>
        <Panel title="Referrers"><div className="talisman-analytics__list">
          {data.referrers.map((item, index) => <div key={`${item.host}-${index}`} className="talisman-analytics__row"><span>{item.host}</span><strong>{number(item.visits)}</strong></div>)}
          {!data.referrers.length && <p className="talisman-analytics__muted">No referral data yet.</p>}
        </div></Panel>
        <Panel title="Countries"><div className="talisman-analytics__list">
          {data.countries.map((item, index) => <div key={`${item.country}-${index}`} className="talisman-analytics__row"><span>{item.country}</span><strong>{number(item.visits)}</strong></div>)}
          {!data.countries.length && <p className="talisman-analytics__muted">No country data yet.</p>}
        </div></Panel>
      </div>
      <p className="talisman-analytics__muted">Cloudflare Web Analytics uses adaptive sampling for some aggregated results. Visits and page views are separate measures.</p>
    </>}
  </div>;
}
