-- Disposable local browser fixture. Apply only to a sanitized rehearsal database, after migrations.
-- TALISMAN_E2E_AFTERCARE_ORDER_ID=ord_99999999-9999-4999-8999-999999999999
INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,status,created_at,updated_at)
VALUES ('aftercare-product','Aftercare returned item','aftercare-product',1000,0,'active',1,1);
INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('aftercare-pool','Aftercare stock pool','AFTERCARE',5,1,1);
INSERT INTO _ecommerce_orders(id,status,fulfillment_status,payment_provider,items,subtotal_amount,total_amount,customer_email,created_at,updated_at) VALUES ('ord_99999999-9999-4999-8999-999999999999','paid','unfulfilled','stripe','[{"productId":"aftercare-product","quantity":4,"priceAtPurchase":1000,"stockTargets":[]}]',4000,4000,'aftercare@example.test',1,1);
INSERT INTO _ecommerce_fulfillments(id,order_id,kind,carrier,tracking_number,note,admin_actor,completes_order,created_at) VALUES ('aftercare-shipment','ord_99999999-9999-4999-8999-999999999999','shipment','Local carrier','LOCAL','Four units shipped','rehearsal',1,1);
INSERT INTO _ecommerce_parcel_contents(fulfillment_id,order_id,source,items,actor,reason,fingerprint,created_at) VALUES ('aftercare-shipment','ord_99999999-9999-4999-8999-999999999999','shipment','[{"lineIndex":0,"quantity":4}]','rehearsal','Local fixture parcel contents','local-fixture',1);
INSERT INTO _ecommerce_return_receipts(id,order_id,items,actor,reason,fingerprint,created_at) VALUES ('aftercare-return','ord_99999999-9999-4999-8999-999999999999','[{"lineIndex":0,"quantity":1,"condition":"damaged","restock":false}]','rehearsal','Local fixture returned goods','local-fixture',1);
INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents,created_at) VALUES ('aftercare-refund','ord_99999999-9999-4999-8999-999999999999','stripe',1000,1);
