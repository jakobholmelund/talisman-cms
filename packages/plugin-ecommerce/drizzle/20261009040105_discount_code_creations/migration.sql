CREATE TABLE `_ecommerce_discount_code_creations` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL UNIQUE,
	`fingerprint` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_discount_code_creations_code__ecommerce_discount_codes_code_fk` FOREIGN KEY (`code`) REFERENCES `_ecommerce_discount_codes`(`code`),
	CONSTRAINT "discount_code_creation_id" CHECK(length("id") = 64 AND "id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "discount_code_creation_fingerprint" CHECK(length("fingerprint") = 64 AND "fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "discount_code_creation_actor" CHECK(length(trim("actor")) BETWEEN 1 AND 128)
);
