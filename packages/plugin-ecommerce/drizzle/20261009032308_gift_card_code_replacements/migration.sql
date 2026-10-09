CREATE TABLE `_ecommerce_gift_card_code_replacements` (
	`id` text PRIMARY KEY,
	`card_id` text NOT NULL,
	`previous_replacement_id` text,
	`previous_code_hash` text NOT NULL,
	`new_code_hash` text NOT NULL UNIQUE,
	`previous_code_suffix` text NOT NULL,
	`new_code_suffix` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_code_replacements_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_code_replacements_previous_replacement_id__ecommerce_gift_card_code_replacements_id_fk` FOREIGN KEY (`previous_replacement_id`) REFERENCES `_ecommerce_gift_card_code_replacements`(`id`),
	CONSTRAINT "gift_card_code_replacement_hashes" CHECK(length("previous_code_hash") = 64 AND length("new_code_hash") = 64 AND "previous_code_hash" <> "new_code_hash"),
	CONSTRAINT "gift_card_code_replacement_suffixes" CHECK(length("previous_code_suffix") = 4 AND length("new_code_suffix") = 4),
	CONSTRAINT "gift_card_code_replacement_balance" CHECK("balance_cents" >= 0),
	CONSTRAINT "gift_card_code_replacement_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "gift_card_code_replacement_reason" CHECK(length(trim("reason")) BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_gift_card_code_replacements_previous_idx` ON `_ecommerce_gift_card_code_replacements` (`card_id`,`previous_code_hash`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_code_replacements_card_idx` ON `_ecommerce_gift_card_code_replacements` (`card_id`,`created_at`);