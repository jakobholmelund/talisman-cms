import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';

test('Stripe checkout applies the reserved credit as an exact fixed coupon', async () => {
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
  const result = await adapter.createCheckoutSession({
    orderId: 'ord_test', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, discountApplied: 2000, successUrl: 'https://example.test/success',
    cancelUrl: 'https://example.test/cancel'
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
    orderId: 'ord_gift', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, discountApplied: 2000, giftCardApplied: 4000,
    successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel'
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
