CREATE TRIGGER `_ecommerce_return_exchange_guard` BEFORE INSERT ON `_ecommerce_return_exchange_preferences`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id
 WHERE r.id=NEW.request_id AND r.redacted_at IS NULL AND o.status IN ('paid','partially_refunded') AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
 AND json_array_length(r.items)=1 AND json_extract(r.items,'$[0].lineIndex')=NEW.line_index
 AND json_extract(NEW.target,'$.currency')=o.currency
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_request_events WHERE request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits WHERE account_id=o.user_id AND action='anonymize'))
 OR NOT EXISTS(SELECT 1 FROM _ecommerce_products p WHERE p.id=json_extract(NEW.target,'$.productId') AND p.status='active' AND p.type='standard' AND p.is_physical=1
 AND json_extract(NEW.target,'$.priceMinor')=CASE WHEN json_extract(NEW.target,'$.variantId') IS NULL THEN CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE product_id=p.id) THEN p.base_price END
 ELSE COALESCE((SELECT COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id WHERE v.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id),
 (SELECT COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g WHERE g.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values WHERE product_variant_id=g.id))) END)
BEGIN SELECT RAISE(ABORT,'Exchange preference changed before the request was recorded'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_exchange_immutable_update` BEFORE UPDATE ON `_ecommerce_return_exchange_preferences` BEGIN SELECT RAISE(ABORT,'Exchange preference history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_exchange_immutable_delete` BEFORE DELETE ON `_ecommerce_return_exchange_preferences` BEGIN SELECT RAISE(ABORT,'Exchange preference history is immutable'); END;
