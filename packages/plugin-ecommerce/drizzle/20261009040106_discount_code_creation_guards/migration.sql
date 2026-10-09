CREATE TRIGGER `_ecommerce_discount_code_creations_no_update` BEFORE UPDATE ON `_ecommerce_discount_code_creations`
BEGIN SELECT RAISE(ABORT, 'Promotion creation requests are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_code_creations_no_delete` BEFORE DELETE ON `_ecommerce_discount_code_creations`
BEGIN SELECT RAISE(ABORT, 'Promotion creation requests are append-only'); END;
