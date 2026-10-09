import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { adminRequest, amountInput, CommerceAdmin, errorText, Feedback, Field, formAmount, money, Panel, Stat, storeCurrency } from './common';

type ClaimLink = { createdAt: string | null; expiresAt: string | null; usedAt: string | null; revokedAt: string | null; resent: boolean };
type Card = { id: string; codeSuffix: string; source: string; initialCents: number;
  balanceCents: number; currency: string; status: 'active' | 'suspended' | 'void'; adminReason: string | null;
  purchaseId: string | null; replacesPurchaseId: string | null; inReview: boolean; buyerEmail: string | null;
  claimLink: ClaimLink | null; claimEmail: { status: string; lastError: string | null; attempts: number } | null };
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
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString() : '';

/** What the buyer was sent: the claim email while it is not sent, and the newest claim link. */
function claimSummary(card: Card) {
  const parts: string[] = [];
  const email = card.claimEmail;
  if (email && email.status !== 'sent') parts.push(`claim email ${email.status}${email.lastError ? ` (${email.lastError})` : ''}`);
  const link = card.claimLink;
  if (link) {
    parts.push(link.usedAt ? `claim link used ${day(link.usedAt)}`
      : link.revokedAt ? 'claim link revoked'
      : link.expiresAt && Date.parse(link.expiresAt) <= Date.now() ? 'claim link expired'
      : `claim link ${link.resent ? 'resent' : 'sent'} ${day(link.createdAt)}, unused`);
  }
  return parts.map(part => ` · ${part}`).join('');
}

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
  const [issuedCardId, setIssuedCardId] = useState('');
  const [codeSaved, setCodeSaved] = useState(false);
  const [issuePending, setIssuePending] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [working, setWorking] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [copyError, setCopyError] = useState(false);
  const [copying, setCopying] = useState(false);
  const issueKey = useRef<string | null>(null);
  const writing = useRef(false);
  const loading = useRef(false);
  const failedRead = useRef(false);
  const activePage = useRef(true);
  const latest = useRef(0);
  const copyingCode = useRef(false);
  const privateCode = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const currency = storeCurrency();
  const canIssue = currency === GIFT_CARD_CURRENCY;
  const currencyCode = GIFT_CARD_CURRENCY.toUpperCase();
  const show = (value: string, failed = false) => { setMessage(value); setError(failed); };
  const blocked = busy || reading || readFailed;
  const cannotWrite = () => writing.current || loading.current || failedRead.current;
  const protectIssuance = issuePending || (Boolean(issuedCode) && !codeSaved);
  useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && (protectIssuance || busy)
      && !window.confirm(issuePending
        ? 'This issuance has not been confirmed. Leaving loses its retry key; a card may already have been created. Leave gift cards?'
        : busy ? 'A gift-card change is still running. Leave gift cards?'
          : 'Have you saved the private gift-card code? Leaving hides it. Leave gift cards?'),
    enableBeforeUnload: protectIssuance || busy,
  });
  useEffect(() => {
    if (message) { feedback.current?.focus({ preventScroll: true }); feedback.current?.scrollIntoView({ block: 'nearest' }); }
  }, [message]);

  async function reload() {
    const request = ++latest.current;
    loading.current = true; setReading(true);
    try {
      const result = await adminRequest<GiftCardData>('gift-cards-admin');
      if (request !== latest.current) return false;
      setCards(result.cards); setReviews(result.reviews); setReviewCount(result.reviewCount);
      setEncryption(result.encryption); setLoaded(true);
      failedRead.current = false; setReadFailed(false);
      return true;
    } catch (cause) {
      if (request === latest.current) {
        failedRead.current = true; setReadFailed(true);
        show(`Could not load gift cards: ${errorText(cause)}. Retry loading before making another change.`, true);
      }
      return false;
    } finally {
      if (request === latest.current) { loading.current = false; setReading(false); }
    }
  }
  useEffect(() => {
    activePage.current = true; void reload();
    return () => { activePage.current = false; ++latest.current; };
  }, []);

  /** Reports a confirmed write separately from a failed list refresh; failed writes keep their forms. */
  async function act(progress: string, task: () => Promise<string | { message: string; error: boolean }>, refreshOnFailure = false) {
    if (cannotWrite()) return;
    writing.current = true; setBusy(true); setWorking(progress); show('');
    try {
      const outcome = await task();
      if (!activePage.current) return;
      const text = typeof outcome === 'string' ? outcome : outcome.message;
      const refreshed = await reload();
      if (!activePage.current) return;
      if (refreshed) show(text, typeof outcome !== 'string' && outcome.error);
      else show(`${text} The gift-card list could not refresh. Retry loading before making another change.`, true);
    } catch (cause) {
      if (!activePage.current) return;
      if (refreshOnFailure) await reload();
      if (activePage.current) show(`${errorText(cause)}${failedRead.current ? ' Retry loading gift cards before making another change.' : ''}`, true);
    } finally {
      writing.current = false;
      if (activePage.current) { setBusy(false); setWorking(''); }
    }
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cannotWrite() || !canIssue) return;
    const form = event.currentTarget; const values = new FormData(form);
    if (issuedCode && !codeSaved && !issueKey.current && !window.confirm('Have you saved the currently displayed private code? Issuing another card replaces its display.')) return;
    const replacesPurchaseId = String(values.get('replacesPurchaseId') || '').trim();
    const requestKey = issueKey.current ?? crypto.randomUUID();
    issueKey.current = requestKey; setIssuePending(true);
    await act('Issuing gift card…', async () => {
      const response = await adminRequest<{ result: { id: string; code: string } }>('gift-cards-admin', { action: 'issue', data: {
        requestKey, amountCents: formAmount(values.get('amount'), GIFT_CARD_CURRENCY),
        reason: String(values.get('reason') || '').trim(),
        ...(replacesPurchaseId ? { replacesPurchaseId } : {}) } });
      if (!response?.result?.code || typeof response.result.code !== 'string' || typeof response.result.id !== 'string' || !response.result.id) {
        throw new Error('The issuance response did not include a private code. Retry the same issuance to recover it.');
      }
      if (activePage.current) {
        setIssuedCode(response.result.code); setIssuedCardId(response.result.id); setCodeSaved(false); setCopyMessage('');
        issueKey.current = null; setIssuePending(false); form.reset();
      }
      return replacesPurchaseId ? 'Replacement issued and the old card voided. Copy the private code now.' : 'Gift card issued. Copy the private code now.';
    });
  }

  async function copyCode() {
    if (copyingCode.current || !issuedCode) return;
    copyingCode.current = true; setCopying(true); setCopyMessage('');
    try {
      await navigator.clipboard.writeText(issuedCode);
      if (activePage.current) { setCodeSaved(true); setCopyError(false); setCopyMessage('Private code copied. Store it securely.'); }
    } catch {
      if (activePage.current) {
        setCopyError(true); setCopyMessage('The code could not be copied automatically. It is selected; copy it manually, then choose “I have saved this code”.');
        privateCode.current?.focus(); privateCode.current?.select();
      }
    } finally {
      copyingCode.current = false; if (activePage.current) setCopying(false);
    }
  }

  async function toggle(card: Card) {
    if (cannotWrite() || (card.status !== 'active' && card.inReview)) return;
    await act('Updating card status…', async () => {
      await adminRequest('gift-cards-admin', { action: 'setActive', id: card.id, active: card.status !== 'active' });
      return 'Card status updated.';
    });
  }

  async function refund(event: FormEvent<HTMLFormElement>, action: 'refundTender' | 'refundGiftOnlyOrder') {
    event.preventDefault();
    if (cannotWrite()) return;
    const form = event.currentTarget; const values = new FormData(form);
    const orderId = String(values.get('orderId') || '').trim();
    const amountCents = formAmount(values.get('amount'), GIFT_CARD_CURRENCY);
    if (!window.confirm(action === 'refundTender'
      ? `Restore ${money(amountCents, GIFT_CARD_CURRENCY)} of gift-card payment for ${orderId}? Check its refund history first; this credits the card.`
      : `Fully refund ${orderId}? This restores its remaining gift-card and shopper-credit payments. Check its refund history first.`)) return;
    await act('Recording gift-card refund…', async () => {
      await adminRequest('gift-cards-admin', { action, data: { orderId, reason: String(values.get('reason') || '').trim(),
        ...(action === 'refundTender' ? { amountCents } : {}) } });
      if (activePage.current) form.reset();
      return 'Gift card refund recorded.';
    });
  }

  // Each decision is its own button, and pressing Enter in the reason field decides nothing.
  async function resolve(form: HTMLFormElement | null, review: Review, outcome: 'reinstate' | 'void') {
    if (cannotWrite() || (outcome === 'reinstate' && (!review.cardId || (review.balanceCents ?? 0) < review.refundedCents - review.adjustedCents))
      || (outcome === 'void' && review.pendingCents > 0) || !form?.reportValidity()) return;
    const reason = String(new FormData(form).get('reason') || '').trim();
    const due = money(review.refundedCents - review.adjustedCents, review.currency);
    if (!window.confirm(outcome === 'reinstate'
      ? `Take ${due} off card •••• ${review.codeSuffix} and lift the review hold on ${review.purchaseId}?`
      : `Void the cards of ${review.purchaseId} and cancel the ${money(review.balanceCents ?? 0, review.currency)} left on them? This cannot be undone.`)) return;
    await act('Recording review decision…', async () => {
      await adminRequest('gift-cards-admin', { action: 'resolveReview', data: {
        purchaseId: review.purchaseId, outcome, reason, refundedCents: review.refundedCents } });
      if (activePage.current) form.reset();
      return outcome === 'reinstate' ? 'Refund taken off the card and the review hold lifted.' : 'Cards voided.';
    }, true);
  }

  // The buyer gets a new one-time link by email; once it is sent, earlier unused links stop working.
  async function resendClaim(form: HTMLFormElement | null, card: Card, purchaseId: string) {
    if (cannotWrite() || !form?.reportValidity()) return;
    const reason = String(new FormData(form).get('reason') || '').trim();
    if (!window.confirm(`Email ${card.buyerEmail ?? 'the buyer'} a new link to the code of card •••• ${card.codeSuffix}? Earlier unused links for ${purchaseId} stop working.`)) return;
    await act('Resending claim link…', async () => {
      await adminRequest('gift-cards-admin', { action: 'resendClaimLink', data: { purchaseId, reason } });
      if (activePage.current) form.reset();
      return 'Claim link sent. It works once, for 7 days.';
    }, true);
  }

  async function reencrypt() {
    if (cannotWrite()) return;
    if (encryption?.legacyCodes && !window.confirm('A Worker from a release before key ids cannot show codes once they are re-encrypted. Re-encrypt them now?')) return;
    await act('Re-encrypting gift-card codes…', async () => {
      let after: string | null = null; let reencrypted = 0; let failed = 0;
      do {
        const response: { result: { reencrypted: number; failed: string[]; next: string | null } } =
          await adminRequest('gift-cards-admin', { action: 'reencryptCodes', data: after ? { after } : {} });
        if (!activePage.current) return '';
        reencrypted += response.result.reencrypted; failed += response.result.failed.length; after = response.result.next;
      } while (after);
      return { message: `${plural(reencrypted, 'code', 'codes')} re-encrypted.${failed ? ` ${failed} could not be decrypted with the configured keys.` : ''}`, error: failed > 0 };
    });
  }

  const issuedCard = cards.find(card => card.id === issuedCardId);
  const active = cards.filter(card => card.status === 'active');
  const visible = cards.filter(card => [card.codeSuffix, card.source, card.status, card.adminReason, card.purchaseId, card.replacesPurchaseId, card.buyerEmail].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const outdated = encryption ? encryption.previousKeyCodes + encryption.legacyCodes : 0;
  return <CommerceAdmin current="gift-cards">
    <p className="ecom-admin__intro">Issue and monitor stored-value gift cards. New codes appear only once, immediately after issuance.</p>
    <div className="ecom-admin__stats"><Stat label="Active cards" value={loaded ? active.length : '—'} detail="Ready to redeem" /><Stat label="Suspended cards" value={loaded ? cards.filter(card => card.status === 'suspended').length : '—'} detail={reviewCount ? `${plural(reviewCount, 'refunded purchase', 'refunded purchases')} held for review` : 'Temporarily unavailable'} /><Stat label="Outstanding balance" value={loaded ? money(active.reduce((sum, card) => sum + card.balanceCents, 0), GIFT_CARD_CURRENCY) : '—'} detail="Across active cards" /></div>
    <div ref={feedback} tabIndex={-1}><Feedback message={message} error={error} /></div>
    <p role="status" aria-live="polite" className={working || reading ? 'ecom-admin__muted' : 'sr-only'}>{working || (reading ? 'Loading gift cards…' : '')}</p>
    {readFailed && <button type="button" aria-disabled={busy || reading} onClick={() => {
      if (writing.current || loading.current) return;
      show(''); void reload();
    }}>Retry loading gift cards</button>}
    <Panel title="Held for review" label="Gift-card purchase reviews">
      <p className="ecom-admin__muted">A Stripe refund of a purchased card suspends the card that holds its value until you decide. Reinstate takes the refund not yet taken off from that card and lifts the hold; a card that was suspended before the refund stays suspended. Void voids the purchase's cards and cancels what is left on them; it waits while a checkout in progress holds value on them. Both need a reason.</p>
      {loaded && !reviews.length && <p className="ecom-admin__muted">No refunded purchases are waiting for a decision.</p>}
      {reviews.map(review => {
        const due = review.refundedCents - review.adjustedCents;
        const balance = review.balanceCents ?? 0;
        const amount = (cents: number) => money(cents, review.currency);
        const card = review.cardId
          ? `${review.cardReplacement ? 'replacement card' : 'card'} •••• ${review.codeSuffix} ${review.cardStatus}${review.cardStatus === 'suspended' && !review.cardHeld ? ' (stays suspended after Reinstate)' : ''}: ${amount(balance)} balance`
          : 'every card void';
        return <div className="ecom-admin__row" role="group" aria-label={`Review ${review.purchaseId}`} key={review.purchaseId}>
          <span><code>{review.purchaseId}</code><small>{amount(review.amountCents)} purchase · {amount(review.refundedCents)} refunded{review.adjustedCents ? `, ${amount(review.adjustedCents)} of it already taken off` : ''} · {card} · {amount(review.spentCents)} spent{review.pendingCents ? ` (${amount(review.pendingCents)} held by a checkout in progress)` : ''}{review.replacementCount ? ` · ${plural(review.replacementCount, 'replacement', 'replacements')} issued` : ''}</small></span>
          <form className="ecom-admin__actions" onSubmit={event => event.preventDefault()}>
            <input readOnly={blocked} name="reason" aria-label={`Reason for ${review.purchaseId}`} placeholder="Reason" minLength={8} maxLength={500} required />
            <button type="button" aria-disabled={blocked || !review.cardId || balance < due} title={review.cardId && balance < due ? 'The balance does not cover the refund' : undefined} onClick={event => void resolve(event.currentTarget.form, review, 'reinstate')} aria-label={`Reinstate ${review.purchaseId}, less ${amount(due)}`}>Reinstate, less {amount(due)}</button>
            <button type="button" className="ecom-admin__secondary" aria-disabled={blocked || review.pendingCents > 0} title={review.pendingCents ? 'Wait until the checkout in progress completes or expires' : undefined} onClick={event => void resolve(event.currentTarget.form, review, 'void')} aria-label={`Void cards for ${review.purchaseId}`}>Void</button>
          </form>
        </div>;
      })}
      {reviewCount > reviews.length && <p className="ecom-admin__muted">Showing the {reviews.length} oldest of {reviewCount}.</p>}
    </Panel>
    <Panel title="Issue a gift card" label="Issue a gift card">
      <p className="ecom-admin__muted">Every administrative issuance records your reason. Share the code through a secure channel. To replace a purchased card, for example when its code was lost, enter its purchase ID and, as the amount, the balance left on it: the old card is voided and its links stop working, its balance moves to the new card, and a later refund of the purchase holds the new card. Resend the claim link from the new card's row to email the buyer its code.</p>
      {!canIssue && <p className="ecom-admin__notice">Gift cards are kept in {currencyCode} only, so a store that sells in {currency.toUpperCase()} cannot issue, sell or redeem them. Existing cards can still be refunded.</p>}
      <form onSubmit={event => void issue(event)}><div className="ecom-admin__grid"><Field label={`Amount (${currencyCode})`}><input readOnly={blocked} name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.issue)} required /></Field><Field label="Reason"><input readOnly={blocked} name="reason" minLength={8} maxLength={500} required /></Field><Field label="Replaces purchase (optional)"><input readOnly={blocked} name="replacesPurchaseId" pattern="gp_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}" placeholder="gp_…" /></Field></div><div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked || !canIssue}>{issuePending ? 'Retry issuance' : 'Issue gift card'}</button></div></form>
      {issuePending && <p className="ecom-admin__notice">If the response was interrupted, retry with the same amount, reason and purchase to recover that card. Keep this page open until the issuance is confirmed.</p>}
      {issuedCode && <section className="ecom-admin__notice" aria-label="Issued private code">
        <strong>Card created — copy this code now</strong>
        {issuedCard && issuedCard.status !== 'active' && <p role="status">This card is currently {issuedCard.status} and cannot be redeemed.</p>}
        <Field label="Private code"><input ref={privateCode} readOnly value={issuedCode} /></Field>
        <div className="ecom-admin__actions"><button type="button" aria-disabled={copying} onClick={() => void copyCode()}>Copy code</button>
          {!codeSaved && <button type="button" className="ecom-admin__secondary" onClick={() => { setCodeSaved(true); setCopyError(false); setCopyMessage('Private code marked as saved.'); }}>I have saved this code</button>}
        </div><Feedback message={copyMessage} error={copyError} />
      </section>}
    </Panel>
    <Panel title="Issued cards">
      <p className="ecom-admin__muted">After payment, the buyer of a card is emailed a one-time link that shows its code once, for 7 days. To send a new link, for example when the email was lost or after a replacement, enter a reason and resend it; earlier unused links stop working.</p>
      <Field label="Find a card"><input type="search" readOnly={busy || reading} value={search} onChange={event => setSearch(event.target.value)} placeholder="Code suffix, source, purchase or buyer email" /></Field>
      {loaded && !visible.length && <p className="ecom-admin__muted">{cards.length ? 'No cards match this search.' : 'No cards issued yet.'}</p>}
      {visible.map(card => {
        // A replacement's links go to the buyer of the purchase it replaces.
        const purchase = card.purchaseId ?? card.replacesPurchaseId;
        return <div className="ecom-admin__row" role="group" aria-label={`Gift card ${card.id}`} key={card.id}><span><strong>•••• {card.codeSuffix}</strong><small>{card.source}{card.purchaseId ? ` · purchase ${card.purchaseId}` : ''}{card.buyerEmail ? ` · bought by ${card.buyerEmail}` : ''} · {money(card.balanceCents, card.currency)} of {money(card.initialCents, card.currency)} remaining · {card.status}{card.replacesPurchaseId ? ` · replaces purchase ${card.replacesPurchaseId}` : ''}{card.adminReason ? ` · ${card.adminReason}` : ''}{claimSummary(card)}</small></span>
          <div className="ecom-admin__actions">
            {purchase && card.status === 'active' && <form className="ecom-admin__actions" onSubmit={event => event.preventDefault()}>
              <input readOnly={blocked} name="reason" aria-label={`Reason to resend the claim link of ${purchase}`} placeholder="Reason to resend" minLength={8} maxLength={500} required />
              <button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={event => void resendClaim(event.currentTarget.form, card, purchase)} aria-label={`Resend claim link for ${card.id}`}>Resend claim link</button>
            </form>}
            {card.status === 'active'
              ? <button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={() => void toggle(card)} aria-label={`Suspend ${card.id}`}>Suspend</button>
              : card.status === 'suspended' && (card.inReview
                ? <small className="ecom-admin__muted">Held for review</small>
                : <button type="button" className="ecom-admin__secondary" aria-disabled={blocked} onClick={() => void toggle(card)} aria-label={`Reactivate ${card.id}`}>Reactivate</button>)}
          </div></div>;
      })}
    </Panel>
    <Panel title="Refund gift card tender" label="Gift-card payment refunds">
      <p className="ecom-admin__muted">Refund Stripe charges in Stripe. A full Stripe refund restores the remaining gift card amount automatically.</p>
      <form onSubmit={event => void refund(event, 'refundTender')}><div className="ecom-admin__grid"><Field label="Order ID"><input readOnly={blocked} name="orderId" required /></Field><Field label={`Gift card amount to restore (${currencyCode})`}><input readOnly={blocked} name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.refund)} required /></Field><Field label="Reason"><input readOnly={blocked} name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked}>Restore gift card amount</button></div></form>
      <h3>Fully refund a gift-card-only order</h3><p className="ecom-admin__muted">This restores its gift card and shopper credit payments together. It is available only when Stripe charged nothing.</p>
      <form onSubmit={event => void refund(event, 'refundGiftOnlyOrder')}><div className="ecom-admin__grid"><Field label="Order ID"><input readOnly={blocked} name="orderId" required /></Field><Field label="Reason"><input readOnly={blocked} name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" aria-disabled={blocked}>Refund entire order</button></div></form>
    </Panel>
    {encryption && <Panel title="Code encryption">
      <p className="ecom-admin__muted">New codes are encrypted with key {encryption.keyId}.{' '}
        {encryption.previousKeyCodes > 0 && `${plural(encryption.previousKeyCodes, 'stored code is', 'stored codes are')} encrypted with a previous key. `}
        {encryption.legacyCodes > 0 && `${plural(encryption.legacyCodes, 'stored code is', 'stored codes are')} in the format of releases before key ids, which the current key or a previous one reads; re-encrypting also ties each code to its card, but a Worker from those releases can no longer show it, so do it once you no longer plan to roll back. `}
        {outdated > 0
          ? 'Re-encrypt them with the current key before you remove a key from TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS.'
          : 'Every stored code uses this key, so no previous key is needed.'}</p>
      {outdated > 0 && <div className="ecom-admin__actions"><button type="button" aria-disabled={blocked} onClick={() => void reencrypt()}>Re-encrypt with the current key</button></div>}
    </Panel>}
  </CommerceAdmin>;
}
