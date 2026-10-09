CREATE TRIGGER `_ecommerce_email_recovery_no_update` BEFORE UPDATE ON `_ecommerce_email_recovery_decisions`
BEGIN SELECT RAISE(ABORT, 'Email recovery requests are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_email_recovery_no_delete` BEFORE DELETE ON `_ecommerce_email_recovery_decisions`
BEGIN SELECT RAISE(ABORT, 'Email recovery requests are append-only'); END;
