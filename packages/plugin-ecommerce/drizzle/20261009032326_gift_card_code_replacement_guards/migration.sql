CREATE TRIGGER `_ecommerce_gift_card_code_replacement_guard` BEFORE INSERT ON `_ecommerce_gift_card_code_replacements`
WHEN NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c WHERE c.id = NEW.card_id
  AND c.source = 'admin' AND c.purchase_id IS NULL AND c.replaces_purchase_id IS NULL
  AND c.status IN ('active','suspended') AND c.held_for_review = 0
  AND c.code_hash = NEW.previous_code_hash AND c.code_suffix = NEW.previous_code_suffix AND c.balance_cents = NEW.balance_cents
  AND NEW.previous_replacement_id IS (SELECT x.id FROM _ecommerce_gift_card_code_replacements x WHERE x.card_id = c.id AND x.new_code_hash = c.code_hash)
  AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_redemptions r WHERE r.card_id = c.id AND r.status = 'reserved'))
BEGIN SELECT RAISE(ABORT, 'Gift card code or eligibility changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_code_replacements_no_update` BEFORE UPDATE ON `_ecommerce_gift_card_code_replacements`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_code_replacements_no_delete` BEFORE DELETE ON `_ecommerce_gift_card_code_replacements`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
