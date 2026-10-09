-- Synthetic local fixture only. Apply to a disposable rehearsal database after migrations.
INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at)
VALUES ('recovery-original','Recovery original item','recovery-original',1000,10,1,'active',1,1),('recovery-exchange','Recovery exchange item','recovery-exchange',1000,12,1,'active',1,1);
INSERT INTO _ecommerce_orders(id,status,fulfillment_status,payment_provider,items,subtotal_amount,total_amount,shipping_address,customer_email,created_at,updated_at)
VALUES ('ord_55555555-5555-4555-8555-555555555555','paid','unfulfilled','stripe','[{"productId":"recovery-original","quantity":4,"priceAtPurchase":1000,"stockTargets":[{"type":"product","id":"recovery-original","units":1}]}]',4000,4000,'{"name":"Rehearsal buyer","line1":"Test street","city":"Test city","postalCode":"000","country":"US"}','recovery@example.test',1,1);
INSERT INTO _ecommerce_fulfillments(id,order_id,kind,carrier,tracking_number,note,admin_actor,completes_order,created_at)
VALUES ('recovery-original-parcel','ord_55555555-5555-4555-8555-555555555555','shipment','Local carrier','ORIGINAL','Four fixture units shipped','rehearsal',1,1);
INSERT INTO _ecommerce_parcel_contents(id,fulfillment_id,order_id,source,items,actor,reason,fingerprint,created_at)
VALUES ('recovery-original-contents','recovery-original-parcel','ord_55555555-5555-4555-8555-555555555555','shipment','[{"lineIndex":0,"quantity":4}]','rehearsal','Fixture original goods recorded','local-fixture',1);
INSERT INTO _ecommerce_return_receipts(id,order_id,items,actor,reason,fingerprint,created_at)
VALUES ('recovery-return','ord_55555555-5555-4555-8555-555555555555','[{"lineIndex":0,"quantity":1,"condition":"inspection","restock":false}]','rehearsal','Fixture returned item awaiting inspection','local-fixture',1);
INSERT INTO _ecommerce_return_inspections(id,receipt_id,order_id,items,actor,reason,fingerprint,created_at)
VALUES ('recovery-inspection','recovery-return','ord_55555555-5555-4555-8555-555555555555','[{"lineIndex":0,"quantity":1,"disposition":"sellable","restock":false}]','rehearsal','Fixture exchange item inspected','local-fixture',1);
INSERT INTO _ecommerce_return_refund_decisions(id,receipt_id,expected_version,status,amount_minor,allocations,actor,reason,fingerprint,created_at)
VALUES ('recovery-no-refund','recovery-return','recovery-return','not_needed',0,'[]','rehearsal','Same-price exchange agreed instead of refund','local-fixture',1);

UPDATE _ecommerce_orders SET guest_access_token_hash='07760d19c26e59909e906a814d318603e386d945b6fb47b3223b30baa7ec4b1f' WHERE id='ord_55555555-5555-4555-8555-555555555555';

INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at)
VALUES ('recovery-upgrade','Recovery upgrade item','recovery-upgrade',1500,12,1,'active',1,1),('recovery-cheap','Recovery cheaper item','recovery-cheap',800,12,1,'active',1,1);
-- A synthetic confirmed refund source for the cheaper-exchange allocation rehearsal.
INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents,created_at) VALUES('recovery-cheap-refund','ord_55555555-5555-4555-8555-555555555555','stripe',200,1);

INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at)
VALUES('customer-exchange-choice','Customer preferred item','customer-exchange-choice',1000,8,1,'active',1,1);

-- Owned shipped order for the customer preference -> approval -> inspected exchange rehearsal.
INSERT INTO _ecommerce_orders(id,status,fulfillment_status,payment_provider,items,subtotal_amount,total_amount,shipping_address,customer_email,guest_access_token_hash,created_at,updated_at)
VALUES ('ord_44444444-4444-4444-8444-444444444444','paid','unfulfilled','stripe','[{"productId":"recovery-original","name":"Recovery original item","quantity":1,"priceAtPurchase":1000,"stockTargets":[{"type":"product","id":"recovery-original","units":1}]}]',1000,1000,'{"name":"Exchange rehearsal buyer","line1":"Test street","city":"Test city","postalCode":"000","country":"US"}','exchange@example.test','7516b575e313ed364fe9bde214303b78246ecd829258f11ab323a89d18fc66e5',strftime('%s','now'),strftime('%s','now'));
INSERT INTO _ecommerce_fulfillments(id,order_id,kind,carrier,tracking_number,note,admin_actor,completes_order,created_at)
VALUES('exchange-request-parcel','ord_44444444-4444-4444-8444-444444444444','shipment','Rehearsal carrier','EXCHANGE-ORIGINAL','Fixture original parcel','rehearsal',1,strftime('%s','now'));
INSERT INTO _ecommerce_parcel_contents(id,fulfillment_id,order_id,source,items,actor,reason,fingerprint,created_at)
VALUES('exchange-request-contents','exchange-request-parcel','ord_44444444-4444-4444-8444-444444444444','shipment','[{"lineIndex":0,"quantity":1}]','rehearsal','Fixture original unit shipped','local-fixture',strftime('%s','now'));
UPDATE _ecommerce_orders SET fulfillment_status='fulfilled' WHERE id='ord_44444444-4444-4444-8444-444444444444';
