import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, amountInput, CommerceAdmin, errorText, Feedback, Field, formAmount, money, Panel, Stat, storeCurrency } from './common';

type Card = { id: string; codeSuffix: string; source: string; initialCents: number; balanceCents: number; currency: string;
  status: 'active' | 'suspended' | 'void'; adminReason: string | null; purchaseId: string | null };

// Migration 0015 keeps gift cards in USD only (see giftCardCurrency in gift-cards.ts). Card amounts,
// including refunds to cards used before a store changed its currency, are in USD.
const GIFT_CARD_CURRENCY = 'usd';
// The server's limits in minor units: amountSchema in gift-cards.ts, and any positive refund.
const limits = { issue: { min: 500, max: 100_000 }, refund: { min: 1 } };

export default function GiftCards() {
  const [cards, setCards] = useState<Card[]>([]);
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
    const result = await adminRequest<{ cards: Card[] }>('gift-cards-admin');
    setCards(result.cards); setLoaded(true);
  }
  useEffect(() => { void reload().catch(cause => show(errorText(cause), true)); }, []);

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setIssuedCode('');
    try {
      const response = await adminRequest<{ result: { code: string } }>('gift-cards-admin', { action: 'issue', data: {
        amountCents: formAmount(values.get('amount'), GIFT_CARD_CURRENCY),
        reason: String(values.get('reason') || '').trim() } });
      setIssuedCode(response.result.code); form.reset(); await reload(); show('Gift card issued. Copy the private code now.');
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

  const active = cards.filter(card => card.status === 'active');
  const visible = cards.filter(card => [card.codeSuffix, card.source, card.status, card.adminReason].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return <CommerceAdmin current="gift-cards">
    <p className="ecom-admin__intro">Issue and monitor stored-value gift cards. New codes appear only once, immediately after issuance.</p>
    <div className="ecom-admin__stats"><Stat label="Active cards" value={active.length} detail="Ready to redeem" /><Stat label="Suspended cards" value={cards.filter(card => card.status === 'suspended').length} detail="Temporarily unavailable" /><Stat label="Outstanding balance" value={money(active.reduce((sum, card) => sum + card.balanceCents, 0), GIFT_CARD_CURRENCY)} detail="Across active cards" /></div>
    <Feedback message={message} error={error} />
    <Panel title="Issue a gift card">
      <p className="ecom-admin__muted">Every administrative issuance records your reason. Share the code through a secure channel.</p>
      {!canIssue && <p className="ecom-admin__notice">Gift cards are kept in {currencyCode} only, so a store that sells in {currency.toUpperCase()} cannot issue, sell or redeem them. Existing cards can still be refunded.</p>}
      <form onSubmit={event => void issue(event)}><div className="ecom-admin__grid"><Field label={`Amount (${currencyCode})`}><input name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.issue)} required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy || !canIssue}>Issue gift card</button></div></form>
      {issuedCode && <div className="ecom-admin__notice"><strong>Card created — copy this code now</strong><Field label="Private code"><input readOnly value={issuedCode} /></Field><div className="ecom-admin__actions"><button type="button" onClick={() => void navigator.clipboard.writeText(issuedCode)}>Copy code</button></div></div>}
    </Panel>
    <Panel title="Issued cards">
      <Field label="Find a card"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Code suffix or source" /></Field>
      {!loaded && !error && <p className="ecom-admin__muted">Loading cards…</p>}
      {loaded && !visible.length && <p className="ecom-admin__muted">{cards.length ? 'No cards match this search.' : 'No cards issued yet.'}</p>}
      {visible.map(card => <div className="ecom-admin__row" key={card.id}><span><strong>•••• {card.codeSuffix}</strong><small>{card.source} · {money(card.balanceCents, card.currency)} of {money(card.initialCents, card.currency)} remaining · {card.status}{card.adminReason ? ` · ${card.adminReason}` : ''}</small></span>{card.status !== 'void' && <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void toggle(card)}>{card.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}</div>)}
    </Panel>
    <Panel title="Refund gift card tender">
      <p className="ecom-admin__muted">Refund Stripe charges in Stripe. A full Stripe refund restores the remaining gift card amount automatically.</p>
      <form onSubmit={event => void refund(event, 'refundTender')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label={`Gift card amount to restore (${currencyCode})`}><input name="amount" type="number" {...amountInput(GIFT_CARD_CURRENCY, limits.refund)} required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Restore gift card amount</button></div></form>
      <h3>Fully refund a gift-card-only order</h3><p className="ecom-admin__muted">This restores its gift card and shopper credit payments together. It is available only when Stripe charged nothing.</p>
      <form onSubmit={event => void refund(event, 'refundGiftOnlyOrder')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Refund entire order</button></div></form>
    </Panel>
  </CommerceAdmin>;
}
