import React, { useEffect, useState, type FormEvent } from 'react';
import { adminRequest, CommerceAdmin, errorText, Feedback, Field, money, Panel } from './common';

type BasketSummary = {
  cart: { id: string; items: Array<{ productId: string; quantity: number }>; checkoutSessionId: string | null } | null;
  quote: { totalAmount: number; requiresShipping: boolean; lines: Array<{ name: string; quantity: number; lineTotal: number }> } | null;
  quoteError: string | null;
  adminEmail: string;
};

export default function TestCheckout() {
  const [summary, setSummary] = useState<BasketSummary | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void adminRequest<BasketSummary>('test-checkout').then(setSummary).catch(cause => setMessage(errorText(cause))); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setMessage('');
    const shippingAddress = summary?.quote?.requiresShipping ? Object.fromEntries(
      ['name', 'line1', 'line2', 'city', 'state', 'postalCode', 'country'].map(key => [key, String(values.get(key) || '').trim()])) : undefined;
    try {
      const result = await adminRequest<{ redirectUrl: string }>('test-checkout', {
        customerEmail: String(values.get('customerEmail') || '').trim(), shippingAddress,
      });
      const destination = new URL(result.redirectUrl, window.location.origin);
      if (destination.origin !== window.location.origin || destination.pathname !== '/checkout/success') {
        throw new Error('Invalid test checkout destination');
      }
      window.location.assign(destination.href);
    } catch (cause) { setMessage(errorText(cause)); setBusy(false); }
  }

  return <CommerceAdmin current="test-checkout">
    <p className="ecom-admin__notice">This simulates a successful payment. No card is charged, sellable stock is not reduced, and the order must not be fulfilled.</p>
    <Feedback message={message} error />
    {!summary && !message && <p className="ecom-admin__muted">Loading basket…</p>}
    {summary && !summary.cart?.items.length && <Panel title="Your basket is empty"><p>Add a product on the storefront first, then return here. <a href="/cart">Open basket</a></p></Panel>}
    {!!summary?.cart?.items.length && summary.quoteError && <Panel title="Basket needs attention"><p>{summary.quoteError}</p><p><a href="/cart">Review basket</a> before placing a test order.</p></Panel>}
    {summary?.cart?.checkoutSessionId && <Panel title="A checkout is already open"><p>Continue or cancel the current payment session from the storefront basket.</p></Panel>}
    {!!summary?.cart?.items.length && !summary.cart.checkoutSessionId && summary.quote && <div className="ecom-admin__grid">
      <Panel title="Test order details"><form onSubmit={event => void submit(event)}>
        <Field label="Email"><input name="customerEmail" type="email" autoComplete="email" defaultValue={summary.adminEmail} required /></Field>
        {summary.quote.requiresShipping && <div className="ecom-admin__grid">
          <Field label="Full name"><input name="name" autoComplete="shipping name" required /></Field>
          <Field label="Address"><input name="line1" autoComplete="shipping address-line1" required /></Field>
          <Field label="Apartment or suite"><input name="line2" autoComplete="shipping address-line2" /></Field>
          <Field label="City"><input name="city" autoComplete="shipping address-level2" required /></Field>
          <Field label="State or region"><input name="state" autoComplete="shipping address-level1" /></Field>
          <Field label="Postal code"><input name="postalCode" autoComplete="shipping postal-code" required /></Field>
          <Field label="Country code"><input name="country" defaultValue="US" maxLength={2} pattern="[A-Za-z]{2}" required /></Field>
        </div>}
        <div className="ecom-admin__actions"><button type="submit" disabled={busy}>Place test order</button></div>
      </form></Panel>
      <Panel title="Order summary">{summary.quote.lines.map((line, index) => <div className="ecom-admin__row" key={index}><span>{line.name} × {line.quantity}</span><strong>{money(line.lineTotal)}</strong></div>)}<div className="ecom-admin__row"><strong>Simulated total</strong><strong>{money(summary.quote.totalAmount)}</strong></div></Panel>
    </div>}
  </CommerceAdmin>;
}
