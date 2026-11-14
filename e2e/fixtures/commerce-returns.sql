-- Synthetic, single-use local fixture; never apply to a real store.
-- TALISMAN_E2E_RETURNS_ORDER_ID=ord_77777777-7777-4777-8777-777777777777
-- Four mapped units have already been reserved. The browser flow records shipment and returns.
INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at)
VALUES ('returns-product','Return rehearsal item','returns-product',1000,10,1,'active',1,1);
INSERT INTO _ecommerce_orders(id,status,fulfillment_status,payment_provider,items,subtotal_amount,total_amount,customer_email,guest_access_token_hash,created_at,updated_at)
VALUES ('ord_77777777-7777-4777-8777-777777777777','paid','unfulfilled','stripe','[{"productId":"returns-product","name":"Return rehearsal item","quantity":4,"priceAtPurchase":1000,"stockTargets":[{"type":"product","id":"returns-product","units":1}]}]',4000,4000,'returns@example.test','2478e8c1aacb9eea639d54afa6ca2a59b3b2f945c66916f4971b878ac8ce0cc4',strftime('%s','now'),strftime('%s','now'));
INSERT INTO _ecommerce_inventory_reservations(id,order_id,target_type,target_id,quantity)
VALUES ('returns-reservation','ord_77777777-7777-4777-8777-777777777777','product','returns-product',4);
