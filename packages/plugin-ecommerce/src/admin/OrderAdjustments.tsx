import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, errorText, Feedback, Field, money } from './common';

type Dispute = {
  id: string; status: string; open: boolean; reason: string | null; amountCents: number; currency: string;
  statusBefore: string; createdAt: string; closedAt: string | null;
};
type Reservation = {
  type: 'inventory' | 'component'; id: string; targetType: string; targetId: string; label: string | null;
  sku: string | null; quantity: number; returnedAt: string | null;
  restock: { adminActor: string; reason: string; createdAt: string } | null; available: boolean;
};
type Adjustments = {
  orderId: string; status: string; fulfillmentStatus: string; restock: 'all' | 'choose' | null; disputes: Dispute[];
  reservations: Reservation[];
};
type Restocked = { result: { restocked: Array<{ quantity: number }> } };
type Waiter = { resolve: (value: Adjustments | null) => void; reject: (reason: unknown) => void };

// The panels on screen ask together: one request loads the disputes and stock of every order shown.
let queued: Map<string, Waiter[]> | null = null;

async function flush() {
  const waiting = queued;
  queued = null;
  if (!waiting) return;
  const ids = [...waiting.keys()];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    try {
      const result = await adminRequest<{ orders: Record<string, Adjustments> }>('orders-admin', { action: 'list', orderIds: chunk });
      for (const id of chunk) for (const waiter of waiting.get(id) ?? []) waiter.resolve(result.orders[id] ?? null);
    } catch (cause) {
      for (const id of chunk) for (const waiter of waiting.get(id) ?? []) waiter.reject(cause);
    }
  }
}

function loadAdjustments(orderId: string) {
  return new Promise<Adjustments | null>((resolve, reject) => {
    if (!queued) {
      queued = new Map();
      setTimeout(() => void flush(), 0);
    }
    queued.set(orderId, [...queued.get(orderId) ?? [], { resolve, reject }]);
  });
}

const words = (value: string) => value.replaceAll('_', ' ');
const when = (value: string) => new Date(value).toLocaleString();
const outcomes: Record<string, string> = { won: 'Dispute won', lost: 'Dispute lost', warning_closed: 'Inquiry closed',
  prevented: 'Dispute prevented' };
const rowKey = (row: Reservation) => `${row.type}:${row.id}`;
const unitCount = (units: number) => `${units} ${units === 1 ? 'unit' : 'units'}`;
const describe = (row: Reservation) => `${row.quantity} × ${row.label ?? `${row.targetId} (no longer in the catalog)`}`
  + `${row.sku ? ` · SKU ${row.sku}` : ''}${row.type === 'component' ? ' · shared component' : ''}`;

/** Disputes of one order and, once it is refunded, returning its stock. Shown inside its orders panel. */
export default function OrderAdjustments({ order }: { order: { id: string; status: string } }) {
  const [data, setData] = useState<Adjustments | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };

  useEffect(() => {
    let current = true;
    loadAdjustments(order.id).then((result) => { if (current) setData(result); },
      (cause) => { if (current) show(errorText(cause), true); });
    return () => { current = false; };
  }, [order.id, order.status]);

  function restock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const chosen = values.getAll('reservation').map(String);
    const reservations = (data?.reservations ?? []).filter((row) => chosen.includes(rowKey(row)));
    if (!reservations.length) {
      show('Tick the items whose stock goes back.', true);
      return;
    }
    const units = reservations.reduce((sum, row) => sum + row.quantity, 0);
    if (!window.confirm(`Return ${unitCount(units)} of stock from ${order.id}? `
      + 'Each item goes back once; this cannot be undone.')) return;
    setBusy(true);
    show('');
    void (async () => {
      try {
        const { result } = await adminRequest<Restocked>('orders-admin', { action: 'restock', orderId: order.id,
          reason: String(values.get('reason') || '').trim(),
          reservations: reservations.map((row) => ({ type: row.type, id: row.id })) });
        form.reset();
        // What went back, which is less than was ticked when another restock returned some items first.
        const returned = result.restocked.reduce((sum, row) => sum + row.quantity, 0);
        const skipped = reservations.length - result.restocked.length;
        show(`${unitCount(returned)} returned to stock.${skipped > 0
          ? ` ${skipped} of the ticked items ${skipped === 1 ? 'was' : 'were'} already back in stock.` : ''}`);
      } catch (cause) {
        show(errorText(cause), true);
      } finally {
        // After a refusal too, so the rows show what is back in stock now.
        await loadAdjustments(order.id).then(setData, () => undefined);
        setBusy(false);
      }
    })();
  }

  if (!data) return <Feedback message={message} error={error} />;
  const openDispute = data.disputes.find((dispute) => dispute.open);
  const disputeLost = data.disputes.some((dispute) => dispute.status === 'lost');
  const left = data.reservations.filter((row) => !row.returnedAt && row.available);
  const settled = data.reservations.filter((row) => row.returnedAt || !row.available);
  // Nothing is ticked in advance, and the form says when goods shipped: neither a refund nor a lost
  // dispute brings them back, and stock returned for goods the buyer kept would be sold twice.
  const shipped = data.fulfillmentStatus === 'fulfilled' ? 'The order has shipped, so return only the items that came back. '
    : data.fulfillmentStatus === 'partially_fulfilled' ? 'Part of the order has shipped; return shipped items only if they came back. '
    : '';
  return <>
    {data.disputes.length > 0 && <>
      <h3>Payment disputes</h3>
      <ul>{data.disputes.map((dispute) => <li key={dispute.id}>
        <strong>{dispute.open ? 'Open dispute' : outcomes[dispute.status] ?? 'Dispute closed'}</strong>
        {' '}· {money(dispute.amountCents, dispute.currency)} · reason: {dispute.reason ? words(dispute.reason) : 'not given'}
        {' '}· Stripe status: {words(dispute.status)} · opened {when(dispute.createdAt)}
        {dispute.closedAt ? `, closed ${when(dispute.closedAt)}` : ''} · <code>{dispute.id}</code>
      </li>)}</ul>
      {openDispute
        ? <p className="ecom-admin__muted">The order cannot ship while a dispute is open. Respond to the dispute in Stripe before its deadline. If it is won, the order is {words(openDispute.statusBefore)} again; if it is lost, the payment is taken back and the order counts as refunded.</p>
        : disputeLost && <p className="ecom-admin__muted">A lost dispute took the payment back, so the order counts as refunded.</p>}
    </>}
    {data.restock && data.reservations.length > 0 && <>
      <h3>Return stock</h3>
      {settled.length > 0 && <ul>{settled.map((row) => <li key={rowKey(row)}>{describe(row)}
        {row.restock ? ` · returned ${when(row.restock.createdAt)} by ${row.restock.adminActor}: ${row.restock.reason}`
          : row.returnedAt ? ` · returned ${when(row.returnedAt)} when its checkout was cancelled`
          : ' · its stock record no longer exists, so it cannot be returned'}</li>)}</ul>}
      {left.length > 0
        // Keyed by the rows left, so the form starts empty again after a restock.
        ? <form key={left.map(rowKey).join(' ')} onSubmit={restock}>
          <p className="ecom-admin__muted">{data.restock === 'all'
            ? 'The order is refunded. Tick the items that came back or never left. '
            : 'The order is partly refunded. Tick the items whose stock goes back. '}
            {shipped}{disputeLost ? 'After a lost dispute the buyer usually keeps the goods. ' : ''}
            Each item is added to the current stock once and recorded with your reason; leave out stock you already corrected by hand.</p>
          {left.map((row) => <label className="ecom-admin__check" key={rowKey(row)}>
            <input type="checkbox" name="reservation" value={rowKey(row)} disabled={busy} />
            <span>{describe(row)}</span>
          </label>)}
          <Field label="Reason for the restock"><input name="reason" minLength={8} maxLength={500} required /></Field>
          <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Return to stock</button></div>
        </form>
        : <p className="ecom-admin__muted">Nothing of this order is left to return to stock.</p>}
    </>}
    <Feedback message={message} error={error} />
  </>;
}
