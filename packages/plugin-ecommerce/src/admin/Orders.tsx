import {useAttentionTarget} from './attention-target';
import { orderReference, customerOrderPath } from '../order-reference';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel, Stat } from './common';
import OrderRecoveryHistory from './OrderRecoveryHistory';
import OrderWarehouse from './OrderWarehouse';
import OrderAdjustments from './OrderAdjustments';
import ReconcileReview from './ReconcileReview';

type View = 'awaiting' | 'recent' | 'partial' | 'shipped' | 'refunded' | 'disputed';
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
  id: string; paymentProvider: string; status: string; fulfillmentStatus: string; customerEmail: string | null; currency: string;
  createdAt: string; shippingAddress: Address | null; canShip: boolean; items: Item[];
  fulfillmentEvents: Array<{ id: string; kind: string; note: string; adminActor: string; createdAt: string }>;
  activity?: Array<{ id: string; kind: string; createdAt: string; detail: string; actor: string | null; actorName: string | null;
    amountCents: number | null; email: { status: string; attempts: number; lastError: string | null; sentAt: string | null; nextAttemptAt: string | null } | null }>;
  amounts: Array<{ key: string; label: string; cents: number }>; shipments: Shipment[];
};
type OrdersPage = { view: View; pageSize: number; awaitingCount: number; nextCursor: string | null; orders: Order[] };

const PAGE_SIZE = 50;
const views: Record<View, string> = { awaiting: 'Awaiting shipment', recent: 'All recent orders', partial: 'Partly shipped', shipped: 'Shipped', refunded: 'Refunds', disputed: 'Disputes' };
const oldestFirst = (view: View) => ['awaiting', 'partial', 'disputed'].includes(view);
const fulfillmentLabels: Record<string, string> = { unfulfilled: 'Not shipped', partially_fulfilled: 'Partly shipped', fulfilled: 'Shipped' };
const statusLabel = (status: string) => status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const formText = (values: FormData, name: string) => String(values.get(name) || '').trim();
const when = (value: string) => new Date(value).toLocaleString();
const tracking = (value: Tracking) => [value.carrier, value.trackingNumber].filter(Boolean).join(' · ') || 'No carrier or tracking number';

/** Keep an opened order mounted when collapsed, preserving forms and request keys. Unopened
 * orders do not mount the warehouse, recovery and refund readers for every row in the queue. */
function OrderCard({ order, children, initiallyOpen }: { order: Order; children: React.ReactNode; initiallyOpen: boolean }) {
  const [opened, setOpened] = useState(initiallyOpen);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const charged = order.amounts.find(amount => amount.key === 'charged' || amount.key === 'total');
  const total = charged ? charged.cents - order.amounts.filter(amount=>['giftCard','storeCredit'].includes(amount.key)).reduce((sum,amount)=>sum+amount.cents,0) : null;
  return <section className="ecom-admin__order" aria-label={`Order ${order.id}`}>
    <details open={expanded} onToggle={event => { setExpanded(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }}>
      <summary className="ecom-admin__order-summary">
        <span className="ecom-admin__order-customer"><strong>{order.customerEmail || 'Guest order'}</strong><small title={order.id}>{orderReference(order.id)}</small></span>
        <span className="ecom-admin__order-date"><time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time><small>{units} {units === 1 ? 'item' : 'items'}{order.shippingAddress?.country ? ` · ${order.shippingAddress.country}` : ''}</small></span>
        <span className="ecom-admin__order-badges"><span className="ecom-admin__badge" data-tone={['disputed', 'refunded', 'partially_refunded'].includes(order.status) ? 'warning' : order.status === 'paid' ? 'success' : 'neutral'}>{statusLabel(order.status)}</span><span className="ecom-admin__badge" data-tone={order.fulfillmentStatus === 'fulfilled' ? 'success' : 'neutral'}>{fulfillmentLabels[order.fulfillmentStatus] ?? statusLabel(order.fulfillmentStatus)}</span></span>
        <span className="ecom-admin__order-total">{total!==null ? money(total, order.currency) : '—'}<small>Order total</small></span>
        <span className="ecom-admin__order-chevron" aria-hidden="true">⌄</span>
      </summary>
      {opened && <div className="ecom-admin__order-detail">{children}</div>}
    </details>
  </section>;
}

export default function Orders() {
  const {hash,target}=useAttentionTarget();
  const [view, setView] = useState<View>('awaiting');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<OrdersPage | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [retryCursor, setRetryCursor] = useState<string | null | undefined>();
  const latest = useRef(0);
  const active = useRef(true);
  const writing = useRef(false);
  const loading = useRef(false);
  const readFailed = useRef(false);
  const warehouseDrafts = useRef(new Set<string>());
  const shipmentKeys = useRef(new WeakMap<HTMLFormElement, string>());
  // The view and search on screen. A reload after a write or a payment check reads them here, so it
  // loads what is selected when it runs, not what was selected when the action began.
  const selected = useRef<{ view: View; query: string }>({ view: 'awaiting', query: '' });
  const feedback = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const focusAfterRead = useRef(false);
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  // The message shows above the list, which can be long; bring it into view.
  useEffect(() => {
    if (message) { feedback.current?.focus({ preventScroll: true }); feedback.current?.scrollIntoView({ block: 'nearest' }); }
  }, [message]);

  /**
   * Loads the first page of the selected view and search, or the page after `cursor`. A response to
   * a superseded request is dropped. The search goes in the request body, never in the URL, so an
   * email address stays out of request logs.
   */
  useEffect(() => {
    if (!reading && focusAfterRead.current) { focusAfterRead.current = false; summary.current?.focus(); }
  }, [reading, page]);

  async function load(cursor?: string | null, focus = false) {
    const request = ++latest.current;
    const { view: currentView, query: currentQuery } = selected.current;
    loading.current = true; setReading(true); setRetryCursor(undefined);
    try {
      const result = await adminRequest<OrdersPage>('fulfillment', { action: 'list', view: currentView,
        limit: PAGE_SIZE, query: currentQuery || null, cursor: cursor || null });
      if (request !== latest.current) return false;
      readFailed.current = false; focusAfterRead.current = focus;
      setPage(result);
      setOrders(current => cursor ? [...current, ...result.orders] : result.orders);
      return true;
    } catch (cause) {
      if (request === latest.current) {
        readFailed.current = true; setRetryCursor(cursor ?? null);
        show(`Could not load orders: ${errorText(cause)}. Retry before recording another change.`, true);
      }
      return false;
    } finally {
      if (request === latest.current) { loading.current = false; setReading(false); }
    }
  }
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; ++latest.current; };
  }, []);

  useEffect(()=>{if(target?.kind==='order'&&selected.current.query!==target.id){setSearch(target.id);select('recent',target.id);}},[hash]);

  async function run(task: () => Promise<unknown>) {
    if (writing.current || loading.current || readFailed.current) return;
    writing.current = true; setBusy(true);
    try { await task(); } catch (cause) { if (active.current) show(errorText(cause), true); }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }

  /** Shows another view or search from its first page. */
  function select(nextView: View, nextQuery: string) {
    if (writing.current) return;
    if (warehouseDrafts.current.size && !window.confirm('Discard the warehouse drafts and change the order list? An unconfirmed change may already be recorded.')) return;
    selected.current = { view: nextView, query: nextQuery };
    setView(nextView); setQuery(nextQuery); setPage(null); setOrders([]); show('');
    void load();
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
    if (!active.current || !await load()) return;
    const failures = result.results.filter(item => item.status === 'error').length;
    show(`Checked ${result.results.length} pending records${failures ? `; ${failures} need attention` : ''}.`, failures > 0);
  });

  /** A refused or unconfirmed write keeps its form and request key so the same parcel can be retried. */
  function record(body: Record<string, unknown>, success: string, form?: HTMLFormElement) {
    void run(async () => {
      show('');
      await adminRequest('fulfillment', body);
      if (!active.current) return;
      // A partly shipped order keeps its form; clear it so the parcel is not recorded twice.
      form?.reset();
      if (form) shipmentKeys.current.delete(form);
      if (await load()) show(success);
      else show(`${success} The orders list could not refresh. Retry loading orders before recording another change.`, true);
    });
  }

  const blocked = busy || reading || retryCursor !== undefined;
  const cannotRecord = () => writing.current || loading.current || readFailed.current;


  function correct(event: FormEvent<HTMLFormElement>, fulfillmentId: string) {
    event.preventDefault();
    if (cannotRecord()) return;
    const values = new FormData(event.currentTarget);
    record({ action: 'correct', fulfillmentId, carrier: formText(values, 'carrier') || null,
      trackingNumber: formText(values, 'trackingNumber') || null, reason: formText(values, 'reason') },
    'Correction recorded. The original shipment record is kept.', event.currentTarget);
  }

  const loadMore = () => run(() => load(page?.nextCursor, true));

  return <CommerceAdmin current="orders">
    <header className="ecom-admin__attention-header ecom-admin__order-header"><div><h2>Every order, in view.</h2><p className="ecom-admin__intro">Review, prepare, and follow up on customer orders.</p></div><button type="button" className="ecom-admin__secondary" disabled={blocked} onClick={() => { show(''); void load(); }}>Refresh orders</button></header>
    <div className="ecom-admin__stats ecom-admin__order-stats">
      <Stat label="Awaiting shipment" value={page ? page.awaitingCount : '—'} detail="Paid real orders not yet shipped in full" />
      <Stat label="Loaded" value={page ? orders.length : '—'} detail={`${views[view]}, ${PAGE_SIZE} per page`} />
    </div>
    <div className="ecom-admin__views" role="group" aria-label="Order views">{Object.entries(views).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} disabled={busy} onClick={() => select(key as View, selected.current.query)}>{label}{key === 'awaiting' && page && <span>{page.awaitingCount}</span>}</button>)}</div>
    <form className="ecom-admin__toolbar ecom-admin__order-search" aria-label="Order search" onSubmit={find}>
      <Field label="Find an order"><input type="search" readOnly={busy} value={search} maxLength={254} onChange={event => setSearch(event.target.value)} placeholder="Order reference, full ID or email address" /></Field>
      <button type="submit" aria-disabled={busy}>Search</button>
      <button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={() => void reconcile()}>Check pending payments</button>
    </form>
    <div ref={feedback} tabIndex={-1}><Feedback message={message} error={error} /></div>
    {query && <p className="ecom-admin__active-search">Searching for <strong>{query}</strong> in {views[view].toLowerCase()}. <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={clearSearch}>Clear search</button></p>}
    {reading && <p role="status" className="ecom-admin__muted">Loading orders…</p>}
    {retryCursor !== undefined && <button type="button" aria-disabled={reading || busy} onClick={() => {
      if (writing.current || loading.current) return;
      show(''); void load(retryCursor, true);
    }}>Retry loading orders</button>}
    {page && !orders.length && <Panel title={query ? 'No matching orders' : view === 'awaiting' ? 'You’re all caught up' : 'No orders in this view'}>
      <p className="ecom-admin__muted">{query ? `No order in ${views[view].toLowerCase()} has this exact ID or email address.`
        : view === 'awaiting' ? 'Every paid order has shipped. New orders that need your attention will appear here.' : `Orders matching ${views[view].toLowerCase()} will appear here.`}</p>
      {(query || view !== 'recent') && <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => select('recent', query)}>Search all recent orders</button>}
    </Panel>}
    {orders.map(order => {
      const address = order.shippingAddress;
      return <OrderCard key={order.id} order={order} initiallyOpen={Boolean(query) && orders.length === 1}>
        <div className="ecom-admin__row"><span><code>{order.id}</code><small>Placed {when(order.createdAt)} · Payment: {statusLabel(order.status)} · Fulfillment: {fulfillmentLabels[order.fulfillmentStatus] ?? statusLabel(order.fulfillmentStatus)}</small></span></div>
        <div className="ecom-admin__row"><span><strong>Customer order page</strong><small>Receipts, parcels, returns and refund updates. The customer must sign in or use their checkout browser.</small></span><button type="button" className="ecom-admin__secondary" onClick={async event => { const button = event.currentTarget; try { await navigator.clipboard.writeText(new URL(customerOrderPath(order.id), window.location.origin).href); button.textContent = 'Customer link copied'; } catch { button.textContent = 'Could not copy — try again'; } }}>Copy customer link</button></div>
        <h3>Items</h3>
        <ul>{order.items.map((item, index) => <li key={index}>
          {item.quantity} × {item.productName ?? `${item.productId} (no longer in the catalog)`}{item.variantLabel ? ` — ${item.variantLabel}` : ''}
          {item.sku ? ` · SKU ${item.sku}` : ' · No SKU'} · {money(item.lineTotal, order.currency)}
        </li>)}</ul>
        <OrderWarehouse order={order} refreshOrders={() => load()} parentBlocked={blocked} canRecord={() => !cannotRecord()} draftChanged={dirty => { if (dirty) warehouseDrafts.current.add(order.id); else warehouseDrafts.current.delete(order.id); }} />
        <details><summary>Order activity</summary>
          <p className="ecom-admin__muted">Recorded shipments, stock returns, tender refunds and email status. Sent means accepted by the email provider.</p>
          {order.activity?.length ? <ul>{order.activity.map(event => <li key={event.id}>
            <strong>{statusLabel(event.kind)}</strong> · {when(event.createdAt)} · {event.detail}
            {event.actor && <> · <span title={event.actor}>{event.actorName || event.actor}</span></>}
            {event.amountCents !== null && <> · {money(event.amountCents, order.currency)}</>}
            {event.email && <> · {statusLabel(event.email.status)} · {event.email.attempts} attempts
              {event.email.sentAt && <> · accepted {when(event.email.sentAt)}</>}
              {event.email.lastError && <> · {event.email.lastError}</>}
              {event.email.nextAttemptAt && <> · next attempt {when(event.email.nextAttemptAt)}</>}</>}
          </li>)}</ul> : <p className="ecom-admin__muted">No operational activity recorded yet.</p>}
        </details>
        <OrderRecoveryHistory orderId={order.id}/>
        <h3>Amounts</h3>
        <ul>{order.amounts.map(amount => <li key={amount.key}>{amount.label}: <strong>{money(amount.cents, order.currency)}</strong></li>)}</ul>
        {address && <address>{address.name}<br />{address.line1}<br />{address.line2 && <>{address.line2}<br /></>}{address.city}, {address.state} {address.postalCode}<br />{address.country}</address>}
        {order.paymentProvider !== 'admin_test' && ['paid', 'partially_refunded', 'refunded'].includes(order.status) && order.fulfillmentStatus !== 'unfulfilled' && (
                  <form onSubmit={event => {
                    event.preventDefault();
                    if (cannotRecord()) return;
                    const form = event.currentTarget;
                    const action = order.fulfillmentStatus === 'fulfilled' ? 'reopen' : 'complete';
                    const requestKey = shipmentKeys.current.get(form) ?? crypto.randomUUID();
                    shipmentKeys.current.set(form, requestKey);
                    record({ action, orderId: order.id, requestKey, reason: formText(new FormData(form), 'reason') }, 'Fulfillment progress updated.', form);
                  }}>
                    <Field label="Reason for changing fulfillment"><input readOnly={blocked} name="reason" required minLength={8} maxLength={500} className="talisman-input" /></Field>
                    <button type="submit" aria-disabled={blocked} className="talisman-btn">{order.fulfillmentStatus === 'fulfilled' ? 'Reopen fulfillment' : 'Complete without another parcel'}</button>
                  </form>
                )}
                {order.fulfillmentEvents?.map(event => <p key={event.id}>{statusLabel(event.kind)}: {event.note} · {event.adminActor} · {when(event.createdAt)}</p>)}
                <OrderAdjustments order={order} />
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
              <div className="ecom-admin__grid"><Field label="Carrier"><input readOnly={blocked} name="carrier" maxLength={100} defaultValue={shipment.carrier ?? ''} /></Field><Field label="Tracking number"><input readOnly={blocked} name="trackingNumber" maxLength={150} defaultValue={shipment.trackingNumber ?? ''} /></Field></div>
              <Field label="Reason for the correction"><input readOnly={blocked} name="reason" minLength={8} maxLength={500} required /></Field>
              <div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked}>Record correction</button></div>
            </form>
          </details>
        </React.Fragment>)}

      </OrderCard>;
    })}
    {page && <p ref={summary} role="status" tabIndex={-1} className="ecom-admin__muted">Showing {orders.length} {orders.length === 1 ? 'order' : 'orders'} in {views[view].toLowerCase()}, {oldestFirst(view) ? 'oldest' : 'newest'} first; {PAGE_SIZE} per page.</p>}
    {page?.nextCursor && <div className="ecom-admin__actions"><button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={() => void loadMore()}>Load {PAGE_SIZE} more</button></div>}
    <ReconcileReview refreshKey={page} />
    <p className="ecom-admin__muted">Payment and shipping are tracked separately. Admin test orders are excluded. Item names and SKUs reflect the current catalog. Refund Stripe charges in Stripe; manage gift card tender refunds in Gift cards.</p>
  </CommerceAdmin>;
}
