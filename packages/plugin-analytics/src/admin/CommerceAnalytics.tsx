import React, { useEffect, useState } from 'react';
import { analyticsRequest, Metric, money, number, Panel, RangePicker, Trend } from './common';
import type { CommerceOverview } from '../commerce';

export default function CommerceAnalytics() {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<CommerceOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    void analyticsRequest<CommerceOverview>('commerce', days, controller.signal)
      .then(setData)
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Commerce analytics unavailable'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days]);

  return <div className="talisman-analytics">
    <div className="talisman-analytics__toolbar"><p>Confirmed ecommerce purchases. Admin test orders are excluded.</p><RangePicker days={days} onChange={setDays} /></div>
    {loading && <p role="status">Loading commerce analytics…</p>}
    {error && <p className="talisman-analytics__error" role="alert">{error}</p>}
    {data && !loading && <>
      {data.currencies.map(row => <div key={row.currency}>
        <h2 className="talisman-analytics__currency">{row.currency.toUpperCase()}</h2>
        <div className="talisman-analytics__metrics">
          <Metric label="Orders" value={number(row.orders)} detail="Confirmed purchases" />
          <Metric label="Gross sales" value={money(row.grossSales, row.currency)} detail="After discounts, before refunds" />
          <Metric label="Net sales" value={money(row.netSales, row.currency)} detail="After recorded refunds" />
          <Metric label="Refunds" value={money(row.refunds, row.currency)} />
          <Metric label="Average order" value={money(row.averageOrderValue, row.currency)} detail="Net sales per order" />
        </div>
        <Panel title={`Net sales by day · ${row.currency.toUpperCase()}`}>
          <Trend points={data.daily.filter(item => item.currency === row.currency).map(item => ({ ...item, value: item.netSales / 100 }))}
            value="value" label={`Daily net sales in ${row.currency.toUpperCase()}`} />
        </Panel>
      </div>)}
      {!data.currencies.length && <Panel title="No confirmed purchases"><p className="talisman-analytics__muted">Paid orders will appear here after payment confirmation.</p></Panel>}
      <Panel title="Top products"><div className="talisman-analytics__list">
        {data.products.map(product => <div key={`${product.id}-${product.currency}`} className="talisman-analytics__row">
          <span><a href={product.editHref}>{product.name}</a><small>{number(product.units)} units · {product.currency.toUpperCase()}</small></span>
          <strong>{money(product.itemSales, product.currency)}</strong>
        </div>)}
        {!data.products.length && <p className="talisman-analytics__muted">No product sales in this period.</p>}
      </div></Panel>
      <p className="talisman-analytics__muted">Sales are grouped by payment date. Product values are before discounts and partial refunds. Gift cards and store credit count as payment toward net sales.</p>
    </>}
  </div>;
}
