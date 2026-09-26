import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, amountInput, CommerceAdmin, errorText, Feedback, Field, formAmount, money, Panel, Stat, storeCurrency } from './common';

type Card = { id: string; codeSuffix: string; source: string; initialCents: number;
  balanceCents: number; currency: string; status: 'active' | 'suspended' | 'void'; adminReason: string | null;
  purchaseId: string | null; replacesPurchaseId: string | null; inReview: boolean };
type Review = { purchaseId: string; amountCents: number; currency: string; refundedCents: number;
  adjustedCents: number; cardId: string | null; codeSuffix: string | null; cardStatus: 'active' | 'suspended' | null;
  cardHeld: boolean; cardReplacement: boolean; balanceCents: number | null; spentCents: number; pendingCents: number;
  replacementCount: number };
type KeyStatus = { keyId: string; previousKeyCodes: number; legacyCodes: number } | null;
type GiftCardData = { cards: Card[]; reviews: Review[]; reviewCount: number; encryption: KeyStatus };

// Migration 0015 keeps gift cards in USD only (see giftCardCurrency in gift-cards.ts). Card amounts,
// including refunds to cards used before a store changed its currency, are in USD.
const GIFT_CARD_CURRENCY = 'usd';
// The server's limits in minor units: amountSchema in gift-cards.ts, and any positive refund.
const limits = { issue: { min: 500, max: 100_000 }, refund: { min: 1 } };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default function GiftCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [encryption, setEncryption] = useState<KeyStatus>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState('');
  const [search, setSearch] = useState('');
  const currency = storeCurrency();
  const canIssue = currency === GIFT_CARD_CURRENCY;
  const currencyCode = GIFT_CARD_CURRENCY.toUpperCase();
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  async function reload() {
    const result = await adminRequest<GiftCardData>('gift-cards-admin');
    setCards(result.cards); setReviews(result.reviews); setReviewCount(result.reviewCount);
    setEncryption(result.encryption); setLoaded(true);
  }
  useEffect(() => { void reload().catch(cause => show(errorText(cause), true)); }, []);

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    const replacesPurchaseId = String(values.get('replacesPurchaseId') || '').trim();
    setBusy(true); setIssuedCode('');
    try {
      const response = await adminRequest<{ result: { code: string } }>('gift-cards-admin', { action: 'issue', data: {
        amountCents: formAmount(values.get('amount'), GIFT_CARD_CURRENCY),
        reason: String(values.get('reason') || '').trim(),
        ...(replacesPurchaseId ? { replacesPurchaseId } : {}) } });
      setIssuedCode(response.result.code); form.reset(); await reload();
      show(replacesPurchaseId ? 'Replacement issued and the old card voided. Copy the private code now.' : 'Gift card issued. Copy the private code now.');
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  async function toggle(card: Card) {
    setBusy(true);
    try { await adminRequest('gift-cards-admin', { action: 'setActive', id: card.id, active: card.status !== 'active' }); await reload(); show('Card status updated.'); }
    catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  async function refund(event: FormEvent<HTMLFormElement>, action: 'refundTender' | 'refundGiftOnlyOrder') {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setBusy(true);
    try {
      await adminRequest('gift-cards-admin', { action, data: {
        orderId: String(values.get('orderId') || '').trim(), reason: String(values.get('reason') || '').trim(),
        ...(action === 'refundTender' ? { amountCents: formAmount(values.get('amount'), GIFT_CARD_CURRENCY) } : {})
      } });
      form.reset(); await reload(); show('Gift card refund recorded.');
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  // Each decision is its own button, and pressing Enter in the reason field decides nothing.
  async function resolve(form: HTMLFormElement | null, review: Review, outcome: 'reinstate' | 'void') {
    if (!form?.reportValidity()) return;
    const reason = String(new FormData(form).get('reason') || '').trim();
    const due = money(review.refundedCents - review.adjustedCents, review.currency);
    if (!window.confirm(outcome === 'reinstate'
      ? `Take ${due} off card •••• ${review.codeSuffix} and lift the review hold on ${review.purchaseId}?`
      : `Void the cards of ${review.purchaseId} and cancel the ${money(review.balanceCents ?? 0, review.currency)} left on them? This cannot be undone.`)) return;
    setBusy(true);
    try {
      // The refund total shown here: if another refund arrives first, the server refuses and the list reloads.
      await adminRequest('gift-cards-admin', { action: 'resolveReview', data: {
        purchaseId: review.purchaseId, outcome, reason, refundedCents: review.refundedCents } });
      form.reset(); await reload();
      show(outcome === 'reinstate' ? 'Refund taken off the card and the review hold lifted.' : 'Cards voided.');
    } catch (cause) {
      show(errorText(cause), true); await reload().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function reencrypt() {
    if (encryption?.legacyCodes && !window.confirm('A Worker from a release before key ids cannot show codes once they are re-encrypted. Re-encrypt them now?')) return;
    setBusy(true);
    try {
      let after: string | null = null; let reencrypted = 0; let failed = 0;
      do {
        const response: { result: { reencrypted: number; failed: string[]; next: string | null } } =
          await adminRequest('gift-cards-admin', { action: 'reencryptCodes', data: after ? { after } : {} });
        reencrypted += response.result.reencrypted; failed += response.result.failed.length; after = response.result.next;
      } while (after);
      await reload();
      show(`${plural(reencrypted, 'code', 'codes')} re-encrypted.${failed ? ` ${failed} could not be decrypted with the configured keys.` : ''}`, failed > 0);
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  const active = cards.filter(card => card.status === 'active');
  const visible = cards.filter(card => [card.codeSuffix, card.source, card.status, card.adminReason, card.purchaseId, card.replacesPurchaseId].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const outdated = encryption ? encryption.previousKeyCodes + encryption.legacyCodes : 0;
  return <CommerceAdmin current="gift-cards">
    <p className="ecom-admin__intro">Issue and monitor stored-value gift cards. New codes appear only once, immediately after issuance.</p>
    <div className="ecom-admin__stats"><Stat label="Active cards" value={active.length} detail="Ready to redeem" /><Stat label="Suspended cards" value={cards.filter(card => card.status === 'suspended').length} detail={reviewCount ? `${plural(reviewCount, 'refunded purchase', 'refunded purchases')} held for review` : 'Temporarily unavailable'} /><Stat label="Outstanding balance" value={money(active.reduce((sum, card) => sum + card.balanceCents, 0), GIFT_CARD_CURRENCY)} detail="Across active cards" /></div>
    <Feedback message={message} error={error} />
    <Panel title="Held for review">
      <p className="ecom-admin__muted">A Stripe refund of a purchased card suspends the card that holds its value until you decide. Reinstate takes the refund not yet taken off from that card and lifts the hold; a card that was suspended before the refund stays suspended. Void voids the purchase's cards and cancels what is left on them; it waits while a checkout in progress holds value on them. Both need a reason.</p>
      {loaded && !reviews.length && <p className="ecom-admin__muted">No refunded purchases are waiting for a decision.</p>}
      {reviews.map(review => {
        const due = review.refundedCents - review.adjustedCents;
        const balance = review.balanceCents ?? 0;
        const amount = (cents: number) => money(cents, review.currency);
        const card = review.cardId
          ? `${review.cardReplacement ? 'replacement card' : 'card'} •••• ${review.codeSuffix} ${review.cardStatus}${review.cardStatus === 'suspended' && !review.cardHeld ? ' (stays suspended after Reinstate)' : ''}: ${amount(balance)} balance`
          : 'every card void';
        return <div className="ecom-admin__row" key={review.purchaseId}>
          <span><code>{review.purchaseId}</code><small>{amount(review.amountCents)} purchase · {amount(review.refundedCents)} refunded{review.adjustedCents ? `, ${amount(review.adjustedCents)} of it already taken off` : ''} · {card} · {amount(review.spentCents)} spent{review.pendingCents ? ` (${amount(review.pendingCents)} held by a checkout in progress)` : ''}{review.replacementCount ? ` · ${plural(review.replacementCount, 'replacement', 'replacements')} issued` : ''}</small></span>
          <form className="ecom-admin__actions" onSubmit={event => event.preventDefault()}>
            <input name="reason" aria-label={`Reason for ${review.purchaseId}`} placeholder="Reason" minLength={8} maxLength={500} required />
            <button type="button" disabled={busy || !review.cardId || balance < due} title={review.cardId && balance < due ? 'The balance does not cover the refund' : undefined} onClick={event => void resolve(event.currentTarget.form, review, 'reinstate')}>Reinstate, less {amount(due)}</button>
            <button type="button" className="ecom-admin__secondary" disabled={busy || review.pendingCents > 0} title={review.pendingCents ? 'Wait until the checkout in progress completes or expires' : undefined} onClick={event => void resolve(event.currentTarget.form, review, 'void')}>Void</button>
          </form>
        </div>;
      })}
      {reviewCount > reviews.length && <p className="ecom-admin__muted">Showing the {reviews.length} oldest of {reviewCount}.</p>}
    </Panel>
    <Panel title="Issue a gift card">
      <p className="ecom-admin__muted">Every administrative issuance records your reason. Share the code through a secure channel. To replace a purchased card, for example when its code was lost, enter its purchase ID and, as the amount, the balance left on it: the old card is voided, its balance moves to the new card, and a later refund of the purchase holds the new card.</p>
      {!canIssue && <p className="ecom-admin__notice">Gift cards are kept in {currencyCode} only, so a store that sells in {currency.toUpperCase()} cannot issue, sell or redeem them. Existing cards can still be refunded.</p>}
      <form onSubmit={event => void issue(event)}><div className="ecom-admin__grid"><Field label={`Amount (${currencyCode})`}><input name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.issue)} required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field><Field label="Replaces purchase (optional)"><input name="replacesPurchaseId" pattern="gp_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}" placeholder="gp_…" /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy || !canIssue}>Issue gift card</button></div></form>
      {issuedCode && <div className="ecom-admin__notice"><strong>Card created — copy this code now</strong><Field label="Private code"><input readOnly value={issuedCode} /></Field><div className="ecom-admin__actions"><button type="button" onClick={() => void navigator.clipboard.writeText(issuedCode)}>Copy code</button></div></div>}
    </Panel>
    <Panel title="Issued cards">
      <Field label="Find a card"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Code suffix, source or purchase" /></Field>
      {!loaded && !error && <p className="ecom-admin__muted">Loading cards…</p>}
      {loaded && !visible.length && <p className="ecom-admin__muted">{cards.length ? 'No cards match this search.' : 'No cards issued yet.'}</p>}
      {visible.map(card => <div className="ecom-admin__row" key={card.id}><span><strong>•••• {card.codeSuffix}</strong><small>{card.source}{card.purchaseId ? ` · purchase ${card.purchaseId}` : ''} · {money(card.balanceCents, card.currency)} of {money(card.initialCents, card.currency)} remaining · {card.status}{card.replacesPurchaseId ? ` · replaces purchase ${card.replacesPurchaseId}` : ''}{card.adminReason ? ` · ${card.adminReason}` : ''}</small></span>{card.status === 'active'
        ? <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void toggle(card)}>Suspend</button>
        : card.status === 'suspended' && (card.inReview
          ? <small className="ecom-admin__muted">Held for review</small>
          : <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void toggle(card)}>Reactivate</button>)}</div>)}
    </Panel>
    <Panel title="Refund gift card tender">
      <p className="ecom-admin__muted">Refund Stripe charges in Stripe. A full Stripe refund restores the remaining gift card amount automatically.</p>
      <form onSubmit={event => void refund(event, 'refundTender')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label={`Gift card amount to restore (${currencyCode})`}><input name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.refund)} required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Restore gift card amount</button></div></form>
      <h3>Fully refund a gift-card-only order</h3><p className="ecom-admin__muted">This restores its gift card and shopper credit payments together. It is available only when Stripe charged nothing.</p>
      <form onSubmit={event => void refund(event, 'refundGiftOnlyOrder')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Refund entire order</button></div></form>
    </Panel>
    {encryption && <Panel title="Code encryption">
      <p className="ecom-admin__muted">New codes are encrypted with key {encryption.keyId}.{' '}
        {encryption.previousKeyCodes > 0 && `${plural(encryption.previousKeyCodes, 'stored code is', 'stored codes are')} encrypted with a previous key. `}
        {encryption.legacyCodes > 0 && `${plural(encryption.legacyCodes, 'stored code is', 'stored codes are')} in the format of releases before key ids, which the current key or a previous one reads; re-encrypting also ties each code to its card, but a Worker from those releases can no longer show it, so do it once you no longer plan to roll back. `}
        {outdated > 0
          ? 'Re-encrypt them with the current key before you remove a key from TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS.'
          : 'Every stored code uses this key, so no previous key is needed.'}</p>
      {outdated > 0 && <div className="ecom-admin__actions"><button type="button" disabled={busy} onClick={() => void reencrypt()}>Re-encrypt with the current key</button></div>}
    </Panel>}
  </CommerceAdmin>;
}
