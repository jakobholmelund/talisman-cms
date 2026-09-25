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
    amount_off: 3000, currency: 'usd', duration: 'once', name: 'Promotion and store credit'
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
