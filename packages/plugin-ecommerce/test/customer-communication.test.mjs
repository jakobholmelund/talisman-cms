import assert from 'node:assert/strict';
import {test} from 'node:test';
import {orderConfirmationEmail,shipmentEmail,returnNoticeEmail,returnRefundEmail,recoveryNoticeEmail} from '../dist/emails.js';
const store={name:'Talisman',origin:'https://shop.test',legalName:null,address:[],supportEmail:'help@shop.test',termsUrl:null,returnsUrl:null,warrantyUrl:null};
const id='ord_88888888-1111-4111-8111-abcdef123456',now=new Date('2026-11-17T00:00:00Z');
test('each post-purchase message carries the readable reference and owner-gated next step',()=>{
 const messages=[
 orderConfirmationEmail({store,order:{id,placedAt:now,currency:'usd',items:[],amounts:[],shippingAddress:null}}),
 shipmentEmail({store,order:{id,placedAt:now},shipment:{id:'parcel',shippedAt:now,carrier:'Carrier',trackingNumber:null,completesOrder:false,earlierShipments:0},update:false}),
 returnNoticeEmail({store,orderId:id,occurredAt:now,status:'approved',message:'Return instructions',items:[]}),
 returnRefundEmail({store,orderId:id,occurredAt:now,currency:'usd',amountMinor:2500,tenders:[{kind:'gift_card',label:'Gift card',amountMinor:2500}]}),
 recoveryNoticeEmail({store,orderId:id,occurredAt:now,kind:'shipment',exchange:true,name:'Shirt',sku:null,quantity:1,carrier:null,trackingNumber:null})
 ];
 for(const message of messages){assert.match(message.text,/TAL-ABCDEF123456/);assert.ok(message.text.includes(`https://shop.test/checkout/success?order=${id}`));assert.ok(message.html.includes('https://shop.test/checkout/success?order='));assert.doesNotMatch(message.text,/[?&]token=/);}
 assert.match(messages[1].text,/More parcels will follow/);assert.match(messages[2].text,/before sending anything back/);
 assert.match(messages[3].text,/restored to your gift card/);assert.doesNotMatch(messages[3].text,/provider may take time/);
});
test('mixed refunds explain each tender without promising carrier delivery or bank timing',()=>{
 const message=returnRefundEmail({store,orderId:id,occurredAt:now,currency:'usd',amountMinor:3000,tenders:[{kind:'provider',label:'Original payment method',amountMinor:1000},{kind:'gift_card',label:'Gift card',amountMinor:1000},{kind:'store_credit',label:'Store credit',amountMinor:1000}]});
 assert.match(message.text,/provider may take time/);assert.match(message.text,/same card code/);assert.match(message.text,/available in your customer hub/);assert.doesNotMatch(message.text,/business days|delivered/);
});
