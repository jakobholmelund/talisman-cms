import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel, Stat } from './common';

type Order = {
  id: string; status: string; customerEmail: string | null; currency: string;
  subtotalAmount: number; totalAmount: number;
  items: Array<{ productId: string; variantId?: string; quantity: number }>;
  shippingAddress?: { name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string } | null;
};
type Fulfillment = { orderId: string; adminActor: string; carrier: string | null; trackingNumber: string | null; note: string };
type OrdersData = { orders: Order[]; fulfillments: Fulfillment[] };

export default function Orders() {
  const [data, setData] = useState<OrdersData | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  async function reload() { setData(await adminRequest<OrdersData>('fulfillment')); }
  useEffect(() => { void reload().catch(cause => { setMessage(errorText(cause)); setError(true); }); }, []);

  async function reconcile() {
    setBusy(true); setMessage('');
    try {
      const result = await adminRequest<{ results: Array<{ status: string }> }>('reconcile', {});
      await reload();
      const failures = result.results.filter(item => item.status === 'error').length;
      setMessage(`Checked ${result.results.length} pending records${failures ? `; ${failures} need attention` : ''}.`);
      setError(failures > 0);
    } catch (cause) { setMessage(errorText(cause)); setError(true); }
    finally { setBusy(false); }
  }

  async function fulfill(event: FormEvent<HTMLFormElement>, orderId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setMessage('');
    try {
      await adminRequest('fulfillment', { orderId,
        carrier: String(values.get('carrier') || '').trim() || null,
        trackingNumber: String(values.get('trackingNumber') || '').trim() || null,
        note: String(values.get('note') || '').trim() });
      await reload();
      setMessage(`Fulfillment recorded for ${orderId}.`); setError(false);
    } catch (cause) { setMessage(errorText(cause)); setError(true); }
    finally { setBusy(false); }
  }

  const orders = data?.orders || [];
  const visible = orders.filter(order =>
    (filter === 'all' || order.status === filter) &&
    `${order.id} ${order.customerEmail || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <CommerceAdmin current="orders">
    <p className="ecom-admin__intro">Confirmed purchases, payment recovery, and fulfillment. Admin test orders are excluded from this queue.</p>
    <div className="ecom-admin__stats">
      <Stat label="Needs fulfillment" value={orders.filter(order => order.status === 'paid').length} detail="Paid orders awaiting shipment" />
      <Stat label="Fulfilled" value={orders.filter(order => order.status === 'fulfilled').length} detail="Shipment recorded" />
      <Stat label="Recent real orders" value={orders.length} detail="Up to 100 orders" />
    </div>
    <div className="ecom-admin__toolbar">
      <Field label="Find an order"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Order ID or email" /></Field>
      <Field label="Status"><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All</option><option value="paid">Needs fulfillment</option><option value="fulfilled">Fulfilled</option><option value="partially_refunded">Partially refunded</option></select></Field>
      <button type="button" disabled={busy} onClick={() => void reconcile()}>Check pending payments</button>
    </div>
    <Feedback message={message} error={error} />
    {!data && !error && <p className="ecom-admin__muted">Loading orders…</p>}
    {data && !visible.length && <Panel title={orders.length ? 'No matching orders' : 'No paid orders yet'}><p className="ecom-admin__muted">{orders.length ? 'Try another search or status.' : 'Confirmed real purchases will appear here.'}</p></Panel>}
    {visible.map(order => {
      const record = data?.fulfillments.find(item => item.orderId === order.id);
      const address = order.shippingAddress;
      return <Panel key={order.id} title={order.customerEmail || order.id}>
        <div className="ecom-admin__row"><span><code>{order.id}</code><small>{order.status.replaceAll('_', ' ')} · {order.items.length} line item{order.items.length === 1 ? '' : 's'}</small></span><strong>{money(order.subtotalAmount || order.totalAmount, order.currency)}</strong></div>
        <ul>{order.items.map((item, index) => <li key={index}>{item.quantity} × {item.productId}{item.variantId ? ` / ${item.variantId}` : ''}</li>)}</ul>
        {address && <address>{address.name}<br />{address.line1}<br />{address.line2 && <>{address.line2}<br /></>}{address.city}, {address.state} {address.postalCode}<br />{address.country}</address>}
        {record && <p className="ecom-admin__muted">Fulfilled by {record.adminActor}. {[record.carrier, record.trackingNumber, record.note].filter(Boolean).join(' · ')}</p>}
        {order.status === 'paid' && <form onSubmit={event => void fulfill(event, order.id)}>
          <h3>Record shipment</h3><p className="ecom-admin__muted">Mark fulfilled only after this order has actually shipped.</p>
          <div className="ecom-admin__grid"><Field label="Carrier"><input name="carrier" maxLength={100} /></Field><Field label="Tracking number"><input name="trackingNumber" maxLength={150} /></Field></div>
          <Field label="Fulfillment note"><input name="note" minLength={8} maxLength={500} required /></Field>
          <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Mark fulfilled</button></div>
        </form>}
      </Panel>;
    })}
    <p className="ecom-admin__muted">Refund Stripe charges in Stripe. Gift card tender refunds are managed in Gift cards.</p>
  </CommerceAdmin>;
}
