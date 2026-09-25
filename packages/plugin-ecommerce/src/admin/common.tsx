import React, { type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
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

export function money(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

const tools: Array<{ key: CommerceTool; label: string }> = [
  { key: 'orders', label: 'Orders' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'gift-cards', label: 'Gift cards' },
  { key: 'test-checkout', label: 'Test checkout' },
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
