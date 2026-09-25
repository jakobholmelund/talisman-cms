import React, { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AskReport } from '../ask';
import { adminBase, Metric, money, number, Panel, refundWording, Trend } from './common';
import { formatRange } from './dates';

const suggestions = [
  'How are sales doing over the last 30 days?',
  'Which products sold best last month?',
  // Neutral about how refunds are dated: without refund dates, a refunds comparison can only
  // compare the refunds on each window's own orders, not the refunds issued in it.
  'Show refunds for the last 30 days',
  'Show traffic and sales for the last 7 days',
];

export default function AskAnalytics() {
  const [question, setQuestion] = useState('');
  const [report, setReport] = useState<AskReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function ask(value: string) {
    const trimmed = value.trim();
    if (trimmed.length < 5 || trimmed.length > 300) {
      setError('Enter a question between 5 and 300 characters.');
      return;
    }
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError(''); setReport(null); setQuestion(trimmed);
    try {
      const response = await fetch(`${adminBase()}/api/analytics/ask`, {
        method: 'POST', credentials: 'same-origin', signal: active.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: trimmed }),
      });
      const body = await response.json() as AskReport & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not create the report.');
      setReport(body);
    } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not create the report.');
    } finally {
      if (!active.signal.aborted) setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  const currencyRows = [...(report?.commerce?.currencies || [])];
  for (const previous of report?.previousCommerce?.currencies || []) {
    if (!currencyRows.some(row => row.currency === previous.currency)) currencyRows.push({
      ...previous, orders: 0, grossSales: 0, netSales: 0, refunds: 0, refundedOrders: 0, charged: 0, averageOrderValue: 0,
    });
  }

  const wording = refundWording(report?.commerce?.refundBasis || 'payment_date');

  return <div className="talisman-analytics talisman-analytics__ask">
    <p className="talisman-analytics__intro">Ask about confirmed sales, products, refunds, or Cloudflare traffic. Each answer is built from the underlying reports.</p>
    <form className="talisman-analytics__ask-form" onSubmit={submit}>
      <label htmlFor="talisman-analytics-question">Your question</label>
      <div className="talisman-analytics__ask-input">
        <input id="talisman-analytics-question" value={question} maxLength={300} onChange={event => setQuestion(event.target.value)}
          placeholder="Which products sold best last month?" />
        <button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create report'}</button>
      </div>
    </form>
    {!report && !loading && <div className="talisman-analytics__suggestions" aria-label="Example questions">
      {suggestions.map(item => <button key={item} type="button" onClick={() => void ask(item)}>{item}</button>)}
    </div>}
    {loading && <p role="status">Reading the question and calculating your report…</p>}
    {error && <p className="talisman-analytics__error" role="alert">{error}</p>}
    {report && <article className="talisman-analytics__report">
      <header className="talisman-analytics__report-header">
        <h2>{report.title}</h2>
        <p>{report.period.label} · {formatRange(report.period.start, report.period.end)}</p>
        {report.previous && <p>Compared with {report.previous.label.charAt(0).toLowerCase()}{report.previous.label.slice(1)} · {formatRange(report.previous.start, report.previous.end)}</p>}
      </header>
      <p className="talisman-analytics__summary">{report.summary}</p>
      {report.commerce && <>
        {currencyRows.map(row => {
          const previous = report.previousCommerce?.currencies.find(item => item.currency === row.currency);
          const refunds = <Metric label="Refunds" value={money(row.refunds, row.currency)}
            detail={previous ? `Previous: ${money(previous.refunds, row.currency)} · ${wording.previous}` : wording.refunds} />;
          return <section key={row.currency}>
            <h3 className="talisman-analytics__currency">{row.currency.toUpperCase()}</h3>
            <div className="talisman-analytics__metrics">
              {report.subject === 'refunds' && <>
                {refunds}
                <Metric label="Refunded orders" value={number(row.refundedOrders)}
                  detail={previous ? `Previous: ${number(previous.refundedOrders)} · ${wording.previous}` : wording.refunds} />
              </>}
              <Metric label="Orders" value={number(row.orders)} detail={previous ? `Previous: ${number(previous.orders)}` : 'Confirmed purchases'} />
              {report.subject !== 'products' && <Metric label="Net sales" value={money(row.netSales, row.currency)} detail={previous ? `Previous: ${money(previous.netSales, row.currency)}` : wording.netSales} />}
              {report.subject === 'sales' || report.subject === 'traffic_and_sales' ? <>
                <Metric label="Gross sales" value={money(row.grossSales, row.currency)} detail="After discounts, before refunds" />
                <Metric label="Average order" value={money(row.averageOrderValue, row.currency)} detail="Gross sales per order" />
              </> : null}
              {report.subject === 'sales' && refunds}
            </div>
            {report.subject !== 'refunds' && report.subject !== 'products' && <Panel title={`Net sales by day · ${row.currency.toUpperCase()}`}>
              <Trend points={report.commerce!.daily.filter(item => item.currency === row.currency).map(item => ({ date: item.date, value: item.netSales / 100 }))}
                value="value" label={`Daily net sales in ${row.currency.toUpperCase()}`} />
            </Panel>}
          </section>;
        })}
        {!report.commerce.currencies.length && <Panel title="No confirmed purchases"><p className="talisman-analytics__muted">Paid orders will appear here after payment confirmation.</p></Panel>}
        {(report.subject === 'products' || report.subject === 'sales') && <Panel title="Top products">
          <div className="talisman-analytics__list">
            {report.commerce.products.map(product => <div key={`${product.id}-${product.currency}`} className="talisman-analytics__row">
              <span><a href={product.editHref}>{product.name}</a><small>{number(product.units)} units · {product.currency.toUpperCase()}</small></span>
              <strong>{money(product.itemSales, product.currency)}</strong>
            </div>)}
            {!report.commerce.products.length && <p className="talisman-analytics__muted">No product sales in this period.</p>}
          </div>
        </Panel>}
      </>}
      {report.traffic && <>
        <div className="talisman-analytics__metrics">
          <Metric label="Page views" value={number(report.traffic.pageViews)} detail={report.previousTraffic ? `Previous: ${number(report.previousTraffic.pageViews)}` : 'Cloudflare Web Analytics'} />
          <Metric label="Visits" value={number(report.traffic.visits)} detail={report.previousTraffic ? `Previous: ${number(report.previousTraffic.visits)}` : 'Cloudflare Web Analytics'} />
        </div>
        <Panel title="Page views by day">
          {report.traffic.trend.length ? <Trend points={report.traffic.trend} value="pageViews" label="Daily page views" /> : <p className="talisman-analytics__muted">No traffic recorded in this period.</p>}
        </Panel>
        <Panel title="Top pages"><div className="talisman-analytics__list">
          {report.traffic.pages.map(page => <div key={page.path} className="talisman-analytics__row"><span><code>{page.path}</code></span><strong>{number(page.pageViews)}</strong></div>)}
        </div></Panel>
      </>}
      <details className="talisman-analytics__notes"><summary>How this report was calculated</summary><ul>{report.notes.map(note => <li key={note}>{note}</li>)}</ul></details>
    </article>}
    <p className="talisman-analytics__muted">Your question is sent to Cloudflare Workers AI to select a report. Order and customer records are not sent to the model.</p>
  </div>;
}
