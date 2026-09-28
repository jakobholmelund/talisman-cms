import React, { type ReactNode } from 'react';
import { adminRequest } from 'talisman-cms/ui/sdk';
import { formatMoney } from './money';
import './analytics.css';

/** Reads a dashboard from the plugin's admin route `<adminPath>/api/analytics/<area>` for the period. */
export function analyticsRequest<T>(area: 'overview' | 'commerce', days: 7 | 30, signal: AbortSignal): Promise<T> {
  return adminRequest<T>(`analytics/${area}?days=${days}`, { signal });
}

export const number = (value: number) => new Intl.NumberFormat().format(value);
/** An amount in the currency's minor units, formatted for the admin's locale. */
export const money = (amount: number, currency: string) => formatMoney(amount, currency);

/**
 * Metric and footnote wording for how refunds are dated (see RefundBasis in ../commerce).
 * `previous` follows a refund metric's value for the period it is compared with.
 */
export function refundWording(basis: 'refund_date' | 'payment_date') {
  return basis === 'refund_date' ? {
    refunds: 'Issued in this period',
    previous: 'issued then',
    netSales: 'Gross sales less refunds issued',
    footnote: 'Refunds count on the date they were issued, and net sales are gross sales less those refunds.',
  } : {
    refunds: 'On orders paid in this period',
    previous: 'on orders paid then',
    netSales: 'Less refunds on these orders so far',
    footnote: 'Refunds count on the payment date of the refunded order, not the date they were issued, so a past period changes when one of its orders is refunded later.',
  };
}

export function RangePicker({ days, onChange }: { days: 7 | 30; onChange: (days: 7 | 30) => void }) {
  return <div className="talisman-analytics__range" role="group" aria-label="Date range">
    <button type="button" aria-pressed={days === 7} onClick={() => onChange(7)}>7 days</button>
    <button type="button" aria-pressed={days === 30} onClick={() => onChange(30)}>30 days</button>
  </div>;
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className="talisman-analytics__metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="talisman-analytics__panel"><h2>{title}</h2>{children}</section>;
}

export function Trend({ points, value, label, format = number }: {
  points: Array<{ date: string; [key: string]: string | number }>;
  value: string; label: string;
  /** Formats a point's value for its tooltip, such as net sales in their currency. */
  format?: (value: number) => string;
}) {
  // Net sales can be negative on a day with more refunds than sales; those bars are marked.
  const max = Math.max(1, ...points.map(point => Math.abs(Number(point[value] || 0))));
  return <div className="talisman-analytics__trend" role="img" aria-label={label}>
    {points.map(point => <div key={point.date} className="talisman-analytics__bar-wrap"
      title={`${point.date}: ${format(Number(point[value] || 0))}`}>
      <div className={`talisman-analytics__bar${Number(point[value] || 0) < 0 ? ' talisman-analytics__bar--negative' : ''}`}
        style={{ height: `${Math.max(2, Math.abs(Number(point[value] || 0)) / max * 100)}%` }} />
      {points.length <= 10 && <span>{point.date.slice(5)}</span>}
    </div>)}
  </div>;
}
