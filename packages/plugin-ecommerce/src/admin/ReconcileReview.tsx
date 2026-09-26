import React, { useEffect, useRef, useState } from 'react';
import { adminRequest, errorText, Feedback, money, Panel } from './common';

type Mode = 'test' | 'live';
type Kind = 'order' | 'gift_card_purchase';
type Parked = {
  kind: Kind; id: string; createdAt: string; parkedAt: string; lastAttemptAt: string | null; attempts: number;
  lastError: string; problem: string; provider: string; sessionMode: Mode | null; otherMode: boolean;
  amountCents: number; currency: string;
};
type ParkedList = { storeMode: Mode; parkedCount: number; parked: Parked[] };
type PaymentReturn = 'refunded' | 'dispute_lost' | 'confirmed';

const kinds: Record<Kind, string> = { order: 'Order', gift_card_purchase: 'Gift card purchase' };
const returned: Record<PaymentReturn, string> = {
  refunded: 'Stripe reports its payment refunded in full.',
  dispute_lost: 'Stripe reports its payment lost to a dispute.',
  confirmed: 'You confirmed its payment was returned.',
};
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const when = (value: string) => new Date(value).toLocaleString();

/** How long ago, in whole hours or days. */
function age(value: string) {
  const hours = Math.floor((Date.now() - Date.parse(value)) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  return hours < 48 ? `${plural(hours, 'hour', 'hours')} ago` : `${plural(Math.floor(hours / 24), 'day', 'days')} ago`;
}

/**
 * Pending orders and gift card purchases whose payment check failed in a way another attempt cannot
 * change. Reconciliation leaves them until an administrator retries or releases them, with a reason
 * that is recorded with their user id. The list reloads whenever `refreshKey` changes, such as after the
 * orders screen checks pending payments. It shows nothing while no record is parked.
 */
export default function ReconcileReview({ refreshKey }: { refreshKey?: unknown }) {
  const [list, setList] = useState<ParkedList | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };

  /** Loads the list; a response to a superseded request is dropped. */
  async function load() {
    const request = ++latest.current;
    const result = await adminRequest<ParkedList>('reconcile');
    if (request === latest.current) setList(result);
  }
  useEffect(() => { void load().catch(cause => show(errorText(cause), true)); }, [refreshKey]);

  // Each action is its own button, and pressing Enter in the reason field decides nothing.
  async function act(form: HTMLFormElement | null, row: Parked, action: 'retry' | 'release') {
    if (!form?.reportValidity()) return;
    const values = new FormData(form);
    const reason = String(values.get('reason') || '').trim();
    const confirmPaymentReturned = values.get('confirmPaymentReturned') === 'on';
    const label = `${kinds[row.kind].toLowerCase()} ${row.id}`;
    const releases = row.kind === 'order' ? `${label} and return its stock and basket` : label;
    const question = action === 'retry'
      ? `Return ${label} to reconciliation? The next run checks it first and parks it again if the check still fails.`
      : row.otherMode
        ? `This checkout session belongs to Stripe ${row.sessionMode} mode, which this store cannot check. Look it up in the Stripe dashboard in ${row.sessionMode} mode first: a paid session must be refunded there. Release ${releases}?`
        : row.lastError === 'session_missing'
          ? `Stripe has no checkout session with this id for the store's key, so it cannot tell whether it was paid. Look it up in the Stripe dashboard first, in every account the store has used: a paid session must be refunded there. Release ${releases}?`
          : `Release ${releases}? Stripe is asked first: an open session is expired, and a paid one is released only once Stripe reports its payment refunded in full or lost to a dispute.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    show('');
    try {
      const { result } = await adminRequest<{ result: { paymentReturned?: PaymentReturn | null } }>('reconcile', {
        action, kind: row.kind, id: row.id, reason, ...(action === 'release' && confirmPaymentReturned ? { confirmPaymentReturned } : {}) });
      form.reset();
      show(action === 'retry' ? `${kinds[row.kind]} ${row.id} is back in reconciliation; the next run checks it first.`
        : `${kinds[row.kind]} ${row.id} was released.${result.paymentReturned ? ` ${returned[result.paymentReturned]}` : ''}`);
    } catch (cause) {
      show(errorText(cause), true);
    } finally {
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  if (!list ? !message : !list.parkedCount && !message) return null;
  const storeMode = list?.storeMode;
  /** The session's Stripe mode, flagged when it is not the store's. */
  const session = (row: Parked) => !row.sessionMode ? ''
    : `Stripe ${row.sessionMode}-mode session${row.otherMode ? `, but the store runs in ${storeMode} mode` : ''} · `;
  return <Panel title="Payment checks parked for review">
    <p className="ecom-admin__muted">Reconciliation parks a pending checkout when another attempt cannot help: Stripe has no session with its id, the session belongs to the other Stripe mode{storeMode ? ` (this store runs in ${storeMode} mode)` : ''}, or a completed payment does not match. A parked checkout keeps its reservations, and its basket stays locked, until you decide. Retry returns it to reconciliation, which checks it first. Release cancels it: an order's stock returns and its basket unlocks. Stripe is asked first unless the session belongs to the other mode, and a paid session is released only once Stripe reports its payment refunded in full or lost to a dispute. Both need a reason, which is recorded with your user id.</p>
    <Feedback message={message} error={error} />
    {list?.parked.map(row => <div className="ecom-admin__row" key={`${row.kind}:${row.id}`}>
      <span>
        <strong>{kinds[row.kind]} <code>{row.id}</code> · {money(row.amountCents, row.currency)}</strong>
        <small>{row.problem} · {session(row)}created {age(row.createdAt)} · parked {when(row.parkedAt)} after {plural(row.attempts, 'attempt', 'attempts')}</small>
      </span>
      <form className="ecom-admin__actions" onSubmit={event => event.preventDefault()}>
        <input name="reason" aria-label={`Reason for ${row.id}`} placeholder="Reason" minLength={8} maxLength={500} required />
        {/* Counts only where Stripe names no payment to check; otherwise Stripe's answer decides. */}
        {row.lastError === 'payment_mismatch' && <label className="ecom-admin__check" title="Counts only where Stripe names no payment the store can check for a refund">
          <input type="checkbox" name="confirmPaymentReturned" /> Payment returned to the shopper
        </label>}
        <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={event => void act(event.currentTarget.form, row, 'retry')}>Retry</button>
        <button type="button" disabled={busy} onClick={event => void act(event.currentTarget.form, row, 'release')}>Release</button>
      </form>
    </div>)}
    {list && list.parkedCount > list.parked.length && <p className="ecom-admin__muted">Showing the {list.parked.length} parked longest of {list.parkedCount}.</p>}
  </Panel>;
}
