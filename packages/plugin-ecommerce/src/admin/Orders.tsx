import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel, Stat } from './common';

type View = 'awaiting' | 'recent';
type Address = { name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
type Item = {
  productId: string; variantId: string | null; quantity: number; lineTotal: number;
  productName: string | null; variantLabel: string | null; sku: string | null;
};
type Tracking = { carrier: string | null; trackingNumber: string | null };
type Correction = Tracking & { id: string; createdAt: string; adminActor: string; reason: string };
type Shipment = Tracking & {
  id: string; createdAt: string; adminActor: string; note: string; completesOrder: boolean;
  recorded: Tracking; corrections: Correction[];
};
type Order = {
  id: string; status: string; fulfillmentStatus: string; customerEmail: string | null; currency: string;
  createdAt: string; shippingAddress: Address | null; canShip: boolean; items: Item[];
  amounts: Array<{ key: string; label: string; cents: number }>; shipments: Shipment[];
};
type OrdersPage = { view: View; pageSize: number; awaitingCount: number; nextCursor: string | null; orders: Order[] };

const PAGE_SIZE = 50;
const views: Record<View, string> = { awaiting: 'Awaiting shipment', recent: 'All recent orders' };
const fulfillmentLabels: Record<string, string> = { unfulfilled: 'Not shipped', partially_fulfilled: 'Partly shipped', fulfilled: 'Shipped' };
const statusLabel = (status: string) => status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const formText = (values: FormData, name: string) => String(values.get(name) || '').trim();
const when = (value: string) => new Date(value).toLocaleString();
const tracking = (value: Tracking) => [value.carrier, value.trackingNumber].filter(Boolean).join(' · ') || 'No carrier or tracking number';

export default function Orders() {
  const [view, setView] = useState<View>('awaiting');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<OrdersPage | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  // The view and search on screen. A reload after a write or a payment check reads them here, so it
  // loads what is selected when it runs, not what was selected when the action began.
  const selected = useRef<{ view: View; query: string }>({ view: 'awaiting', query: '' });
  const feedback = useRef<HTMLDivElement>(null);
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  // The message shows above the list, which can be long; bring it into view.
  useEffect(() => { if (message) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [message]);

  /**
   * Loads the first page of the selected view and search, or the page after `cursor`. A response to
   * a superseded request is dropped. The search goes in the request body, never in the URL, so an
   * email address stays out of request logs.
   */
  async function load(cursor?: string | null) {
    const request = ++latest.current;
    const { view: currentView, query: currentQuery } = selected.current;
    const result = await adminRequest<OrdersPage>('fulfillment', { action: 'list', view: currentView,
      limit: PAGE_SIZE, query: currentQuery || null, cursor: cursor || null });
    if (request !== latest.current) return;
    setPage(result);
    setOrders(current => cursor ? [...current, ...result.orders] : result.orders);
  }
  useEffect(() => { void load().catch(cause => show(errorText(cause), true)); }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try { await task(); } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  /** Shows another view or search from its first page. */
  function select(nextView: View, nextQuery: string) {
    selected.current = { view: nextView, query: nextQuery };
    setView(nextView); setQuery(nextQuery); setPage(null); setOrders([]); show('');
    void load().catch(cause => show(errorText(cause), true));
  }

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    select(selected.current.view, search.trim());
  }

  function clearSearch() {
    setSearch('');
    select(selected.current.view, '');
  }

  const reconcile = () => run(async () => {
    show('');
    const result = await adminRequest<{ results: Array<{ status: string }> }>('reconcile', {});
    await load();
    const failures = result.results.filter(item => item.status === 'error').length;
    show(`Checked ${result.results.length} pending records${failures ? `; ${failures} need attention` : ''}.`, failures > 0);
  });

  /** Sends a shipment or a correction, then reloads the first page, after a refusal too, so a stale order drops out. */
  function record(body: Record<string, unknown>, success: string, form?: HTMLFormElement) {
    void run(async () => {
      show('');
      try {
        await adminRequest('fulfillment', body);
        // A partly shipped order keeps its form; clear it so the parcel is not recorded twice.
        form?.reset();
        show(success);
      } finally {
        await load().catch(() => undefined);
      }
    });
  }

  function ship(event: FormEvent<HTMLFormElement>, order: Order) {
    event.preventDefault();
    const orderId = order.id;
    const values = new FormData(event.currentTarget);
    const completesOrder = values.has('completesOrder');
    // Parcels of a split shipment are recorded one by one; closing the order early cannot be undone.
    if (completesOrder && order.fulfillmentStatus === 'partially_fulfilled'
      && !window.confirm(`Record this as the last parcel of ${orderId}? The order then counts as shipped in full, and no further parcels can be recorded for it.`)) {
      return;
    }
    record({ action: 'ship', orderId, completesOrder, carrier: formText(values, 'carrier') || null,
      trackingNumber: formText(values, 'trackingNumber') || null, note: formText(values, 'note') },
    completesOrder ? `Shipment recorded; ${orderId} has shipped in full.` : `Partial shipment recorded for ${orderId}.`,
    event.currentTarget);
  }

  function correct(event: FormEvent<HTMLFormElement>, fulfillmentId: string) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    record({ action: 'correct', fulfillmentId, carrier: formText(values, 'carrier') || null,
      trackingNumber: formText(values, 'trackingNumber') || null, reason: formText(values, 'reason') },
    'Correction recorded. The original shipment record is kept.');
  }

  const loadMore = () => run(() => load(page?.nextCursor));

  return <CommerceAdmin current="orders">
    <p className="ecom-admin__intro">Confirmed purchases, payment recovery, and shipping. Payment and fulfillment are tracked separately, so a refund never hides a shipment. Admin test orders are excluded. Item names and SKUs come from the current catalog.</p>
    <div className="ecom-admin__stats">
      <Stat label="Awaiting shipment" value={page ? page.awaitingCount : '—'} detail="Paid real orders not yet shipped in full" />
      <Stat label="Loaded" value={page ? orders.length : '—'} detail={`${views[view]}, ${PAGE_SIZE} per page`} />
    </div>
    <form className="ecom-admin__toolbar" onSubmit={find}>
      <Field label="View"><select value={view} onChange={event => select(event.target.value as View, selected.current.query)}>
        <option value="awaiting">{views.awaiting} (oldest first)</option>
        <option value="recent">{views.recent} (newest first)</option>
      </select></Field>
      <Field label="Find an order"><input type="search" value={search} maxLength={254} onChange={event => setSearch(event.target.value)} placeholder="Exact order ID or email address" /></Field>
      <button type="submit" disabled={busy}>Search</button>
      {query && <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={clearSearch}>Clear search</button>}
      <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void reconcile()}>Check pending payments</button>
    </form>
    <div ref={feedback}><Feedback message={message} error={error} /></div>
    {!page && !error && <p className="ecom-admin__muted">Loading orders…</p>}
    {page && !orders.length && <Panel title={query ? 'No matching orders' : view === 'awaiting' ? 'Nothing awaiting shipment' : 'No orders yet'}>
      <p className="ecom-admin__muted">{query ? `No order in ${views[view].toLowerCase()} has this exact ID or email address.`
        : view === 'awaiting' ? 'Paid real orders that still need to ship appear here, oldest first.' : 'Confirmed real purchases appear here, newest first.'}</p>
    </Panel>}
    {orders.map(order => {
      const address = order.shippingAddress;
      return <Panel key={order.id} title={order.customerEmail || order.id}>
        <div className="ecom-admin__row"><span><code>{order.id}</code><small>Placed {when(order.createdAt)} · Payment: {statusLabel(order.status)} · Fulfillment: {fulfillmentLabels[order.fulfillmentStatus] ?? statusLabel(order.fulfillmentStatus)}</small></span></div>
        <h3>Items</h3>
        <ul>{order.items.map((item, index) => <li key={index}>
          {item.quantity} × {item.productName ?? `${item.productId} (no longer in the catalog)`}{item.variantLabel ? ` — ${item.variantLabel}` : ''}
          {item.sku ? ` · SKU ${item.sku}` : ' · No SKU'} · {money(item.lineTotal, order.currency)}
        </li>)}</ul>
        <h3>Amounts</h3>
        <ul>{order.amounts.map(amount => <li key={amount.key}>{amount.label}: <strong>{money(amount.cents, order.currency)}</strong></li>)}</ul>
        {address && <address>{address.name}<br />{address.line1}<br />{address.line2 && <>{address.line2}<br /></>}{address.city}, {address.state} {address.postalCode}<br />{address.country}</address>}
        {order.shipments.length > 0 && <h3>Shipments</h3>}
        {order.shipments.map(shipment => <React.Fragment key={shipment.id}>
          <div className="ecom-admin__row"><span>
            <strong>{shipment.completesOrder ? 'Shipment that completes the order' : 'Partial shipment'}: {tracking(shipment)}</strong>
            <small>{when(shipment.createdAt)} · recorded by {shipment.adminActor} · {shipment.note}</small>
            {shipment.corrections.length > 0 && <small>First recorded as {tracking(shipment.recorded)}</small>}
            {shipment.corrections.map(correction => <small key={correction.id}>Corrected {when(correction.createdAt)} by {correction.adminActor} to {tracking(correction)}. Reason: {correction.reason}</small>)}
          </span></div>
          <details>
            <summary>Correct carrier or tracking number</summary>
            <form key={`${shipment.id}-${shipment.corrections.length}`} onSubmit={event => correct(event, shipment.id)}>
              <p className="ecom-admin__muted">A correction is added to the history; the shipment as first recorded is kept.</p>
              <div className="ecom-admin__grid"><Field label="Carrier"><input name="carrier" maxLength={100} defaultValue={shipment.carrier ?? ''} /></Field><Field label="Tracking number"><input name="trackingNumber" maxLength={150} defaultValue={shipment.trackingNumber ?? ''} /></Field></div>
              <Field label="Reason for the correction"><input name="reason" minLength={8} maxLength={500} required /></Field>
              <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Record correction</button></div>
            </form>
          </details>
        </React.Fragment>)}
        {order.canShip && <form onSubmit={event => ship(event, order)}>
          <h3>Record shipment</h3><p className="ecom-admin__muted">Record a shipment only after the parcel has left. A shipment that completes the order cannot be undone: the order leaves the queue and no further parcels can be recorded for it. For an order sent in several parcels, clear the checkbox on all but the last.</p>
          <div className="ecom-admin__grid"><Field label="Carrier"><input name="carrier" maxLength={100} /></Field><Field label="Tracking number"><input name="trackingNumber" maxLength={150} /></Field></div>
          <Field label="Shipment note"><input name="note" minLength={8} maxLength={500} required /></Field>
          <div className="ecom-admin__actions"><label className="ecom-admin__check"><input type="checkbox" name="completesOrder" defaultChecked /> This shipment completes the order</label></div>
          <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Record shipment</button></div>
        </form>}
      </Panel>;
    })}
    {page && orders.length > 0 && <p className="ecom-admin__muted">Showing {orders.length} {orders.length === 1 ? 'order' : 'orders'}{view === 'awaiting' ? ' awaiting shipment, oldest first' : ', newest first'}; {PAGE_SIZE} per page.</p>}
    {page?.nextCursor && <div className="ecom-admin__actions"><button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void loadMore()}>Load {PAGE_SIZE} more</button></div>}
    <p className="ecom-admin__muted">Refund Stripe charges in Stripe. Gift card tender refunds are managed in Gift cards.</p>
  </CommerceAdmin>;
}
