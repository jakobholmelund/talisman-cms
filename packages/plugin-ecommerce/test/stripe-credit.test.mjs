import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';

/** An adapter whose Stripe client records the coupons and sessions it is asked to create. */
function recordingAdapter() {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake' });
  const calls = [];
  adapter.stripe = {
    coupons: { async create(input, options) {
      calls.push({ type: 'coupon', input, options });
      return { id: 'coupon_credit' };
    } },
    checkout: { sessions: { async create(input, options) {
      calls.push({ type: 'session', input, options });
      return { id: 'cs_test', url: 'https://checkout.stripe.com/test' };
    } } }
  };
  return { adapter, calls };
}

const urls = { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' };

test('Stripe checkout applies the reserved credit as an exact fixed coupon', async () => {
  const { adapter, calls } = recordingAdapter();
  const result = await adapter.createCheckoutSession({
    orderId: 'ord_test', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, discountApplied: 2000, ...urls
  });
  assert.equal(result.providerSessionId, 'cs_test');
  assert.deepEqual(calls[0].input, {
    id: 'ord_test_discount', amount_off: 3000, currency: 'usd', duration: 'once', max_redemptions: 1,
    redeem_by: calls[1].input.expires_at, name: 'Promotion and store credit'
  });
  assert.equal(calls[0].options.idempotencyKey, 'ord_test:discount');
  assert.deepEqual(calls[1].input.discounts, [{ coupon: 'coupon_credit' }]);
  assert.equal(calls[1].options.idempotencyKey, 'ord_test');
  calls.length = 0;
  await adapter.createCheckoutSession({
    orderId: 'ord_gift', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, discountApplied: 2000, giftCardApplied: 4000, ...urls
  });
  assert.equal(calls[0].input.amount_off, 7000);
  assert.equal(calls[0].input.name, 'Gift card and checkout adjustments');
});

test('Stripe dispute status is looked up by payment intent and settled disputes count as none', async () => {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake' });
  const calls = [];
  let disputes = [];
  adapter.stripe = { disputes: { async list(params) {
    calls.push(params);
    return { data: disputes.map((status) => ({ status })) };
  } } };
  const cases = [
    [[], 'none'], [['won'], 'none'], [['prevented'], 'none'], [['warning_closed'], 'none'],
    [['needs_response'], 'open'], [['under_review'], 'open'], [['warning_needs_response'], 'open'],
    [['warning_under_review'], 'open'], [['won', 'needs_response'], 'open'], [['won', 'lost'], 'lost'],
    [['needs_response', 'lost'], 'lost'],
  ];
  for (const [statuses, expected] of cases) {
    disputes = statuses;
    assert.equal(await adapter.getDisputeStatus('pi_test'), expected, statuses.join(','));
  }
  assert.ok(calls.every((params) => params.payment_intent === 'pi_test'));
});

test('Stripe charges every line, coupon and session in the order currency and never presents another', async () => {
  const { adapter, calls } = recordingAdapter();
  await adapter.createCheckoutSession({
    orderId: 'ord_eur', currency: 'eur', creditApplied: 1000, ...urls,
    items: [{ name: 'Frames', priceCents: 12000, quantity: 2 }, { name: 'Case', priceCents: 2000, quantity: 1 }],
  });
  const [coupon, session] = calls;
  assert.equal(coupon.input.currency, 'eur');
  assert.deepEqual(session.input.line_items.map(line => line.price_data.currency), ['eur', 'eur']);
  assert.equal(session.input.currency, 'eur');
  // Adaptive Pricing would let Stripe charge a local currency that the order cannot confirm.
  assert.deepEqual(session.input.adaptive_pricing, { enabled: false });

  // A session without adjustments, such as a gift card purchase, is pinned too.
  calls.length = 0;
  await adapter.createCheckoutSession({ orderId: 'gp_test', currency: 'usd', ...urls,
    items: [{ name: 'Digital gift card', priceCents: 5000, quantity: 1 }], metadata: { giftCardPurchaseId: 'gp_test' } });
  assert.deepEqual(calls.map(call => call.type), ['session']);
  assert.equal(calls[0].input.line_items[0].price_data.currency, 'usd');
  assert.equal(calls[0].input.currency, 'usd');
  assert.deepEqual(calls[0].input.adaptive_pricing, { enabled: false });
});

test('Stripe charges shipping as its own line, which the one coupon can reduce like the items', async () => {
  const { adapter, calls } = recordingAdapter();
  await adapter.createCheckoutSession({
    orderId: 'ord_shipped', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, giftCardApplied: 500, ...urls,
    shipping: { label: 'Express shipping', amount: 2500, description: 'Delivery in 1–2 business days' },
  });
  const [coupon, session] = calls;
  assert.deepEqual(session.input.line_items.at(-1), {
    price_data: { currency: 'usd', product_data: { name: 'Express shipping', description: 'Delivery in 1–2 business days' },
      unit_amount: 2500 },
    quantity: 1,
  });
  assert.equal(coupon.input.amount_off, 1500);
  const lines = session.input.line_items.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0);
  assert.equal(lines - coupon.input.amount_off, 13000);

  // Free shipping adds no line.
  calls.length = 0;
  await adapter.createCheckoutSession({ orderId: 'ord_free_shipping', currency: 'usd', ...urls,
    items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }], shipping: { label: 'Standard shipping', amount: 0 } });
  assert.deepEqual(calls.map(call => call.type), ['session']);
  assert.deepEqual(calls[0].input.line_items.map(line => line.price_data.product_data.name), ['Frames']);
});

test('Stripe refund status is read from the payment intent\'s latest charge', async () => {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake' });
  const calls = [];
  let charge = null;
  adapter.stripe = { paymentIntents: { async retrieve(id, params) {
    calls.push([id, params]);
    return { id, latest_charge: charge };
  } } };
  const cases = [
    [null, 'none'], ['ch_not_expanded', 'none'], [{ amount: 5000, amount_refunded: 0, refunded: false }, 'none'],
    [{ amount: 5000, amount_refunded: 250, refunded: false }, 'partial'], [{ amount: 5000, amount_refunded: 5000, refunded: true }, 'full'],
  ];
  for (const [latest, expected] of cases) {
    charge = latest;
    assert.equal(await adapter.getRefundStatus('pi_test'), expected, JSON.stringify(latest));
  }
  assert.ok(calls.every(([id, params]) => id === 'pi_test' && params.expand.includes('latest_charge')));
});
