import React, { type ReactNode } from 'react';
import './analytics.css';

export function adminBase() {
  if (typeof window === 'undefined') return '/admin';
  const marker = '/extensions/';
  const index = window.location.pathname.indexOf(marker);
  return index > 0 ? window.location.pathname.slice(0, index) : '/admin';
}

export async function analyticsRequest<T>(area: 'overview' | 'commerce', days: 7 | 30, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${adminBase()}/api/analytics/${area}?days=${days}`, { credentials: 'same-origin', signal });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Analytics request failed');
  return result;
}

export const number = (value: number) => new Intl.NumberFormat().format(value);
export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

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

export function Trend({ points, value, label }: {
  points: Array<{ date: string; [key: string]: string | number }>;
  value: string; label: string;
}) {
  const max = Math.max(1, ...points.map(point => Number(point[value] || 0)));
  return <div className="talisman-analytics__trend" role="img" aria-label={label}>
    {points.map(point => <div key={point.date} className="talisman-analytics__bar-wrap"
      title={`${point.date}: ${number(Number(point[value] || 0))}`}>
      <div className="talisman-analytics__bar" style={{ height: `${Math.max(2, Number(point[value] || 0) / max * 100)}%` }} />
      {points.length <= 10 && <span>{point.date.slice(5)}</span>}
    </div>)}
  </div>;
}
