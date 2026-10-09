-- Disposable local browser fixture. Apply only to a sanitized rehearsal database, after migrations.
-- TALISMAN_E2E_PURCHASING_ORDER_ID=ord_66666666-6666-4666-8666-666666666666
INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,status,created_at,updated_at)
VALUES ('purchasing-product','Aftercare returned item','purchasing-product',1000,0,'active',1,1);
INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('purchasing-pool','Purchasing stock pool','PURCHASING',5,1,1);
INSERT INTO _ecommerce_orders(id,status,fulfillment_status,payment_provider,items,subtotal_amount,total_amount,customer_email,created_at,updated_at) VALUES ('ord_66666666-6666-4666-8666-666666666666','paid','unfulfilled','stripe','[{"productId":"purchasing-product","quantity":4,"priceAtPurchase":1000,"stockTargets":[]}]',4000,4000,'purchasing@example.test',1,1);
INSERT INTO _ecommerce_fulfillments(id,order_id,kind,carrier,tracking_number,note,admin_actor,completes_order,created_at) VALUES ('purchasing-shipment','ord_66666666-6666-4666-8666-666666666666','shipment','Local carrier','LOCAL','Four units shipped','rehearsal',1,1);
INSERT INTO _ecommerce_parcel_contents(fulfillment_id,order_id,source,items,actor,reason,fingerprint,created_at) VALUES ('purchasing-shipment','ord_66666666-6666-4666-8666-666666666666','shipment','[{"lineIndex":0,"quantity":4}]','rehearsal','Local fixture parcel contents','local-fixture',1);
INSERT INTO _ecommerce_return_receipts(id,order_id,items,actor,reason,fingerprint,created_at) VALUES ('purchasing-return','ord_66666666-6666-4666-8666-666666666666','[{"lineIndex":0,"quantity":1,"condition":"damaged","restock":false}]','rehearsal','Local fixture returned goods','local-fixture',1);
INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents,created_at) VALUES ('purchasing-refund','ord_66666666-6666-4666-8666-666666666666','stripe',1000,1);

INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('purchasing-second','Purchasing second pool','PURCHASING-SECOND',8,1,1);
UPDATE _ecommerce_orders SET guest_access_token_hash='3d6ac22975a9d151030be025e9af9468073edc80c86e6d36fea464d2ad75111f' WHERE id='ord_66666666-6666-4666-8666-666666666666';
