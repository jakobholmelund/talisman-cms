import React from 'react';
import { Link } from '@tanstack/react-router';
import type { readCommerceAttention, AttentionKind } from '@talisman-cms/plugin-ecommerce/operations';
import { CommerceAdmin, Panel } from './common';
import { dateTime, OperationsReadStatus, useOperationsRead } from './operations-common';

type Snapshot = Awaited<ReturnType<typeof readCommerceAttention>>;
const validSnapshot = (value: unknown): value is Snapshot => !!value && typeof value === 'object'
  && Array.isArray((value as Snapshot).rows) && !!(value as Snapshot).counts && typeof (value as Snapshot).checkedAt === 'string';
const groups: Array<{ kind: AttentionKind; title: string; tool: string; label: string; help: string }> = [
  { kind: 'payment_review', title: 'Payment reviews', tool: 'orders', label: 'Review payments', help: 'Automatic reconciliation stopped and needs a recorded staff decision.' },
  { kind: 'older_payments', title: 'Older pending payments', tool: 'orders', label: 'Open orders and payment reviews', help: 'Checkouts pending for at least 24 hours. The scheduled reconciler continues checking them.' },
  { kind: 'tax_review', title: 'Tax reviews', tool: 'orders', label: 'Review tax', help: 'Tax transactions or reversals waiting for staff review.' },
  { kind: 'email', title: 'Email problems', tool: 'emails', label: 'Open email recovery', help: 'Failed notices and pending notices with a recorded error.' },
  { kind: 'gift_hold', title: 'Held gift cards', tool: 'gift-cards', label: 'Review gift cards', help: 'Cards held after a refund or payment dispute. Open disputes must reach an outcome first.' },
  { kind: 'shipment', title: 'Awaiting shipment', tool: 'orders', label: 'Open fulfillment queue', help: 'Paid orders with a shipping address that still need fulfillment.' },
  { kind: 'return_request', title: 'Return requests', tool: 'returns', label: 'Review return requests', help: 'Customer requests awaiting a staff decision and return instructions.' },
  { kind: 'inspection', title: 'Pending inspections', tool: 'returns', label: 'Inspect received returns', help: 'Received goods awaiting a recorded inspection decision.' },
  { kind: 'dispute', title: 'Open payment disputes', tool: 'orders', label: 'Open orders', help: 'Provider disputes still awaiting an outcome. Gift card disputes are managed in Gift cards.' },
];
export default function Attention() {
  const { data, loading, error, load } = useOperationsRead<Snapshot>('view=attention', validSnapshot);
  return <CommerceAdmin current="attention"><p className="ecom-admin__intro">A daily queue for keeping the store moving. Each group shows its ten oldest records.</p>
    <OperationsReadStatus loading={loading} error={error} reload={() => void load()} />
    {data && <><p>Checked {dateTime(data.checkedAt)}</p><div className="ecom-admin__grid">{groups.map(group => {
      const rows = data.rows.filter(row => row.kind === group.kind);
      return <Panel key={group.kind} title={`${group.title} (${data.counts[group.kind] ?? 0})`} label={group.title}>
        <p>{group.help}</p><Link to="/extensions/$extensionPath" params={{ extensionPath: `commerce-${group.tool}` }}>{group.label}</Link>
        {group.kind === 'dispute' && <p><Link to="/extensions/$extensionPath" params={{ extensionPath: 'commerce-gift-cards' }}>Open gift cards</Link></p>}
        {!rows.length ? <p>No records need attention here.</p> : <ul>{rows.map(row => <li key={`${row.subject}:${row.id}`}><strong>{row.subject}: {row.id}</strong><br />{dateTime(row.createdAt)}{row.detail ? ` · ${row.detail}` : ''}</li>)}</ul>}
      </Panel>;
    })}</div></>}
  </CommerceAdmin>;
}
