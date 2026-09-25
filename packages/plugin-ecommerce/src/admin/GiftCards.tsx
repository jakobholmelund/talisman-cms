import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel, Stat } from './common';

type Card = { id: string; codeSuffix: string; source: string; initialCents: number;
  balanceCents: number; status: 'active' | 'suspended' | 'void'; adminReason: string | null; purchaseId: string | null };

export default function GiftCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState('');
  const [search, setSearch] = useState('');
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
        amountCents: Math.round(Number(values.get('amount')) * 100),
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
        ...(action === 'refundTender' ? { amountCents: Math.round(Number(values.get('amount')) * 100) } : {})
      } });
      form.reset(); await reload(); show('Gift card refund recorded.');
    } catch (cause) { show(errorText(cause), true); } finally { setBusy(false); }
  }

  const active = cards.filter(card => card.status === 'active');
  const visible = cards.filter(card => [card.codeSuffix, card.source, card.status, card.adminReason].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return <CommerceAdmin current="gift-cards">
    <p className="ecom-admin__intro">Issue and monitor stored-value gift cards. New codes appear only once, immediately after issuance.</p>
    <div className="ecom-admin__stats"><Stat label="Active cards" value={active.length} detail="Ready to redeem" /><Stat label="Suspended cards" value={cards.filter(card => card.status === 'suspended').length} detail="Temporarily unavailable" /><Stat label="Outstanding balance" value={money(active.reduce((sum, card) => sum + card.balanceCents, 0))} detail="Across active cards" /></div>
    <Feedback message={message} error={error} />
    <Panel title="Issue a gift card">
      <p className="ecom-admin__muted">Every administrative issuance records your reason. Share the code through a secure channel.</p>
      <form onSubmit={event => void issue(event)}><div className="ecom-admin__grid"><Field label="Amount (USD)"><input name="amount" type="number" min="5" max="1000" step="0.01" required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Issue gift card</button></div></form>
      {issuedCode && <div className="ecom-admin__notice"><strong>Card created — copy this code now</strong><Field label="Private code"><input readOnly value={issuedCode} /></Field><div className="ecom-admin__actions"><button type="button" onClick={() => void navigator.clipboard.writeText(issuedCode)}>Copy code</button></div></div>}
    </Panel>
    <Panel title="Issued cards">
      <Field label="Find a card"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Code suffix or source" /></Field>
      {!loaded && !error && <p className="ecom-admin__muted">Loading cards…</p>}
      {loaded && !visible.length && <p className="ecom-admin__muted">{cards.length ? 'No cards match this search.' : 'No cards issued yet.'}</p>}
      {visible.map(card => <div className="ecom-admin__row" key={card.id}><span><strong>•••• {card.codeSuffix}</strong><small>{card.source} · {money(card.balanceCents)} of {money(card.initialCents)} remaining · {card.status}{card.adminReason ? ` · ${card.adminReason}` : ''}</small></span>{card.status !== 'void' && <button type="button" className="ecom-admin__secondary" disabled={busy} onClick={() => void toggle(card)}>{card.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}</div>)}
    </Panel>
    <Panel title="Refund gift card tender">
      <p className="ecom-admin__muted">Refund Stripe charges in Stripe. A full Stripe refund restores the remaining gift card amount automatically.</p>
      <form onSubmit={event => void refund(event, 'refundTender')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label="Gift card amount to restore (USD)"><input name="amount" type="number" min="0.01" step="0.01" required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Restore gift card amount</button></div></form>
      <h3>Fully refund a gift-card-only order</h3><p className="ecom-admin__muted">This restores its gift card and shopper credit payments together. It is available only when Stripe charged nothing.</p>
      <form onSubmit={event => void refund(event, 'refundGiftOnlyOrder')}><div className="ecom-admin__grid"><Field label="Order ID"><input name="orderId" required /></Field><Field label="Reason"><input name="reason" minLength={8} maxLength={500} required /></Field></div><div className="ecom-admin__actions"><button type="submit" disabled={busy}>Refund entire order</button></div></form>
    </Panel>
  </CommerceAdmin>;
}
