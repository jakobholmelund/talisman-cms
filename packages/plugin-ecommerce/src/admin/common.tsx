import React, { type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { adminTestCheckout } from 'virtual:talisman-cms/ecommerce-admin';
import { formatMoney, fromMinorUnits, toMinorUnits } from '@talisman-cms/plugin-ecommerce/money';
import './commerce-admin.css';

export type CommerceTool = 'orders' | 'promotions' | 'gift-cards' | 'test-checkout';

export function adminBase() {
  if (typeof window === 'undefined') return '/admin';
  const marker = '/extensions/';
  const index = window.location.pathname.indexOf(marker);
  return index > 0 ? window.location.pathname.slice(0, index) : '/admin';
}

export async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${adminBase()}/api/ecommerce/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Commerce request failed');
  return result;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

/** An amount in the currency's minor units as text: money(1250, 'usd') is "$12.50", money(1250, 'jpy') "¥1,250". */
export function money(amount: number, currency: string) {
  return formatMoney(amount, currency);
}

/**
 * The currency the store sells in, from the talisman-commerce-currency meta tag that the admin page
 * renders from TALISMAN_COMMERCE_CURRENCY. Discount values, referral rewards and store credit are
 * amounts in its minor units.
 */
export function storeCurrency() {
  const content = typeof document === 'undefined' ? undefined
    : document.querySelector('meta[name="talisman-commerce-currency"]')?.getAttribute('content')?.trim().toLowerCase();
  return content && /^[a-z]{3}$/.test(content) ? content : 'usd';
}

/**
 * Bounds and step for an amount typed in major units, from the server's limits in minor units.
 * The step is one minor unit: 0.01 for USD, 1 for JPY, 0.001 for KWD.
 */
export function amountInput(currency: string, limits: { min: number; max?: number }) {
  return {
    min: fromMinorUnits(limits.min, currency),
    max: limits.max === undefined ? undefined : fromMinorUnits(limits.max, currency),
    step: fromMinorUnits(1, currency),
  };
}

/** A form amount typed in major units, such as 12.50, in the currency's minor units: 1250 for USD. */
export function formAmount(value: FormDataEntryValue | null, currency: string) {
  return toMinorUnits(Number(value || 0), currency);
}

const tools: Array<{ key: CommerceTool; label: string }> = [
  { key: 'orders', label: 'Orders' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'gift-cards', label: 'Gift cards' },
  // Registered only with ecommercePlugin({ adminTestCheckout: true }).
  ...(adminTestCheckout ? [{ key: 'test-checkout' as const, label: 'Test checkout' }] : []),
];

export function CommerceAdmin({ current, children }: { current: CommerceTool; children: ReactNode }) {
  return <div className="ecom-admin">
    <nav className="ecom-admin__nav" aria-label="Commerce tools">
      <Link to="/commerce">Commerce workspace</Link>
      {tools.map(tool => <Link key={tool.key} to="/extensions/$extensionPath" params={{ extensionPath: `commerce-${tool.key}` }} aria-current={current === tool.key ? 'page' : undefined}>{tool.label}</Link>)}
    </nav>
    {children}
  </div>;
}

export function Feedback({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <p className={`ecom-admin__feedback${error ? ' ecom-admin__feedback--error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p> : null;
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return <div className="ecom-admin__stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ecom-admin__panel"><h2>{title}</h2>{children}</section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="ecom-admin__field"><span>{label}</span>{children}</label>;
}
