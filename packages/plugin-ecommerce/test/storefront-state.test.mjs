import assert from 'node:assert/strict';
import {test} from 'node:test';
import {orderProgress} from '../src/components/order-progress.ts';
import {estimatedPayment,shippingOptionsFor} from '../src/components/delivery-options.ts';

test('customer status never promises fulfillment for pending, failed, cancelled or refunded payments',()=>{
  assert.match(orderProgress('paid').detail,/Payment confirmed/);
  for(const status of ['pending','failed','cancelled','refunded','unknown'])assert.notEqual(orderProgress(status).tone,'paid');
  assert.match(orderProgress('pending',true).detail,/before making another payment/);
  assert.match(orderProgress('refunded').title,/refunded/);
});
test('delivery estimates use discounted merchandise and keep credit separate from free-shipping eligibility',()=>{
  const settings={deliveryCountries:['US'],shippingRates:[{id:'standard',label:'Standard',amount:800,freeOver:30000,countries:['US'],minDays:3,maxDays:7}]};
  assert.equal(shippingOptionsFor(settings,'US',30000)[0].amount,0);
  const rate=shippingOptionsFor(settings,'US',27000)[0];
  assert.equal(rate.amount,800);
  assert.equal(rate.description,'Delivery in 3–7 business days');
  assert.deepEqual(shippingOptionsFor(settings,'GB',40000),[]);
  assert.equal(estimatedPayment(30000,rate.amount,{discountAmount:3000,creditApplied:5000,giftCardApplied:2000}),20800);
  assert.equal(estimatedPayment(1000,0,{giftCardApplied:1500}),0);
});
