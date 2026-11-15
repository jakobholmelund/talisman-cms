import React, { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { readCommerceAttention, AttentionKind } from '@talisman-cms/plugin-ecommerce/operations';
import { CommerceAdmin, Panel } from './common';
import { dateTime, OperationsReadStatus, useOperationsRead } from './operations-common';

type Snapshot = Awaited<ReturnType<typeof readCommerceAttention>>;
const groups: Array<{ kind: AttentionKind; title: string; tool: string; label: string; help: string }> = [
  { kind: 'payment_review', title: 'Payment reviews', tool: 'orders', label: 'Review payments', help: 'Automatic reconciliation stopped and needs a recorded staff decision.' },
  { kind: 'older_payments', title: 'Older pending payments', tool: 'orders', label: 'Open orders and payment reviews', help: 'Checkouts pending for at least 24 hours. The scheduled reconciler continues checking them.' },
  { kind: 'tax_review', title: 'Tax reviews', tool: 'orders', label: 'Review tax', help: 'Tax transactions or reversals waiting for staff review.' },
  { kind: 'email', title: 'Email problems', tool: 'emails', label: 'Open email recovery', help: 'Failed notices and pending notices with a recorded error.' },
  { kind: 'gift_hold', title: 'Held gift cards', tool: 'gift-cards', label: 'Review gift cards', help: 'Cards held after a refund or payment dispute. Open disputes must reach an outcome first.' },
  { kind: 'shipment', title: 'Awaiting shipment', tool: 'orders', label: 'Open fulfillment queue', help: 'Paid orders with a shipping address that still need fulfillment.' },
  { kind: 'return_request', title: 'Return requests', tool: 'returns', label: 'Review return requests', help: 'Customer requests awaiting a staff decision and return instructions.' },
  { kind: 'inspection', title: 'Pending inspections', tool: 'returns', label: 'Inspect received returns', help: 'Received goods awaiting a recorded inspection decision.' },
  { kind: 'refund', title: 'Return refund follow-up', tool: 'refunds', label: 'Review return refunds', help: 'Received goods awaiting a refund decision or confirmed refund allocation.' },
  { kind: 'parcel_recovery', title: 'Parcel problems and exchanges', tool: 'recoveries', label: 'Review parcels and exchanges', help: 'Open delivery incidents and exchanges awaiting replacement or a recorded resolution.' },
  { kind: 'supplier_issue', title: 'Supplier delivery issues', tool: 'purchasing', label: 'Review supplier issues', help: 'Short, damaged or incorrect deliveries needing recorded supplier follow-up, including completed and cancelled purchases.' },
  { kind: 'incoming', title: 'Overdue incoming stock', tool: 'replenishment', label: 'Review expected deliveries', help: 'Expected deliveries past their due date with units still outstanding.' },
  { kind: 'dispute', title: 'Open payment disputes', tool: 'orders', label: 'Open orders', help: 'Provider disputes still awaiting an outcome. Gift card disputes are managed in Gift cards.' },
];

const areas = [
  { key: 'delivery', label: 'Shipping', kinds: ['shipment'] },
  { key: 'aftercare', label: 'Returns & exchanges', kinds: ['return_request', 'inspection', 'refund', 'parcel_recovery'] },
  { key: 'money', label: 'Payments & gift cards', kinds: ['payment_review', 'older_payments', 'tax_review', 'gift_hold', 'dispute'] },
  { key: 'stock', label: 'Stock & suppliers', kinds: ['supplier_issue', 'incoming'] },
  { key: 'messages', label: 'Customer emails', kinds: ['email'] },
] as const;
const validSnapshot = (value: unknown): value is Snapshot => {
  if (!value || typeof value !== 'object') return false;
  const s = value as Snapshot;
  return Array.isArray(s.rows) && !!s.counts && typeof s.counts === 'object'
    && Number.isFinite(Date.parse(s.checkedAt))
    && groups.every(g => s.counts[g.kind] === undefined || (Number.isSafeInteger(s.counts[g.kind]) && s.counts[g.kind]! >= 0))
    && s.rows.every(r => r && groups.some(g => g.kind === r.kind) && typeof r.id === 'string'
      && typeof r.subject === 'string' && Number.isFinite(Date.parse(r.createdAt)) && (r.detail === null || typeof r.detail === 'string'));
};
function age(createdAt: string, checkedAt: string) {
  const hours = Math.max(0, Math.floor((Date.parse(checkedAt) - Date.parse(createdAt)) / 3600000));
  return hours >= 24 ? `${Math.floor(hours / 24)}d in queue` : hours ? `${hours}h in queue` : 'Less than 1h in queue';
}
function recordTarget(row: Snapshot['rows'][number]) {
  const kind = ({ return_request: 'request', inspection: 'inspection', refund: 'refund', parcel_recovery: 'recovery' } as Partial<Record<AttentionKind, string>>)[row.kind];
  if (!kind) return null;
  return new URLSearchParams({ kind, id: row.id, ...(kind === 'inspection' ? { orderId: row.detail ?? '' } : {}) }).toString();
}
export default function Attention() {
  const { data, loading, error, load } = useOperationsRead<Snapshot>('view=attention', validSnapshot);
  const [area, setArea] = useState('all'), [showClear, setShowClear] = useState(false);
  const count = (kinds: readonly AttentionKind[]) => kinds.reduce((n, kind) => n + (data?.counts[kind] ?? 0), 0);
  const total = count(groups.map(g => g.kind));
  const visible = groups.filter(g => (area === 'all' || areas.find(a => a.key === area)?.kinds.some(k => k === g.kind))
    && (showClear || (data?.counts[g.kind] ?? 0) > 0)).sort((a, b) => {
      const oldest = (kind: AttentionKind) => Math.min(...(data?.rows.filter(r => r.kind === kind).map(r => Date.parse(r.createdAt)) ?? []));
      return oldest(a.kind) - oldest(b.kind);
    });
  function records(rows: Snapshot['rows'], tool: string) {
    return <ul className="ecom-admin__attention-records">{rows.map(row => {
      const target = recordTarget(row);
      return <li key={`${row.subject}:${row.id}`}>
        <div className="ecom-admin__attention-record-heading"><strong>{row.subject.replaceAll('_', ' ')}</strong><span className="ecom-admin__badge" data-aged={Date.parse(data!.checkedAt) - Date.parse(row.createdAt) >= 7 * 86400000 || undefined} title={dateTime(row.createdAt)}>{age(row.createdAt, data!.checkedAt)}</span></div>
        <code>{row.id}</code><small>Recorded {dateTime(row.createdAt)}</small>
        {target && <Link to="/extensions/$extensionPath" params={{ extensionPath: `commerce-${tool}` }} hash={target}>Open case · {row.id}</Link>}
        {row.detail && <details><summary>Recorded detail</summary><p>{row.detail}</p></details>}
      </li>;
    })}</ul>;
  }
  return <CommerceAdmin current="attention"><div className="ecom-admin__attention">
    <header className="ecom-admin__attention-header"><div><p className="ecom-admin__eyebrow">Daily store work</p><h1>Needs attention</h1><p className="ecom-admin__intro">Choose a work area, then start with its oldest tasks. Counts cover the full queues; previews show up to ten records each.</p></div><div><OperationsReadStatus loading={loading} error={error} reload={() => void load()} />{data && <small>Snapshot checked {dateTime(data.checkedAt)}</small>}</div></header>
    {data && <>
      <div className="ecom-admin__attention-areas" role="group" aria-label="Work areas">
        <button type="button" aria-pressed={area === 'all'} onClick={() => setArea('all')}><span>All work</span><strong>{total.toLocaleString()}</strong><small>queue tasks</small></button>
        {areas.map(a => <button key={a.key} type="button" aria-pressed={area === a.key} onClick={() => setArea(a.key)}><span>{a.label}</span><strong>{count(a.kinds).toLocaleString()}</strong><small>queue tasks</small></button>)}
      </div>
      <p className="ecom-admin__muted">An order can appear in several queues. These counts are tasks, not unique orders.</p>
      <div className="ecom-admin__attention-options"><h2>{area === 'all' ? 'All work areas' : areas.find(a => a.key === area)?.label}</h2><label className="ecom-admin__check"><input type="checkbox" checked={showClear} onChange={e => setShowClear(e.target.checked)} />Show clear queues</label></div>
      <p role="status" className="ecom-admin__muted">{visible.length} queues shown · Oldest tasks first</p>
      {!visible.length && <Panel title={total === 0 ? 'All queues are clear' : 'This work area is clear'}><p>{total === 0 ? 'No tasks were waiting at the last snapshot.' : 'There are no waiting tasks in this work area.'} Refresh to check for new work.</p></Panel>}
      <div className="ecom-admin__grid">{visible.map(group => {
        const rows = data.rows.filter(row => row.kind === group.kind);
        const total = data.counts[group.kind] ?? 0;
        return <Panel key={group.kind} title={`${group.title} (${total})`} label={group.title}>
          <p>{group.help}</p><Link to="/extensions/$extensionPath" params={{ extensionPath: `commerce-${group.tool}` }}>{group.label}</Link>
          {group.kind === 'dispute' && <p><Link to="/extensions/$extensionPath" params={{ extensionPath: 'commerce-gift-cards' }}>Open gift cards</Link></p>}
          {!total ? <p className="ecom-admin__muted">No records need attention here.</p> : <>
            {records(rows.slice(0, 3), group.tool)}
            {rows.length > 3 && <details><summary>Show {rows.length - 3} more preview records</summary>{records(rows.slice(3), group.tool)}</details>}
            <p className="ecom-admin__muted">{rows.length} of {total} queue records in this preview. Open the full queue for current status and all records.</p>
          </>}
        </Panel>;
      })}</div>
    </>}
  </div></CommerceAdmin>;
}
