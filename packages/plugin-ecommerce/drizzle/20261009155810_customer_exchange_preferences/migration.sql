CREATE TABLE `_ecommerce_return_exchange_preferences` (
	`request_id` text PRIMARY KEY,
	`line_index` integer NOT NULL,
	`target` text NOT NULL,
	CONSTRAINT `fk__ecommerce_return_exchange_preferences_request_id__ecommerce_return_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `_ecommerce_return_requests`(`id`),
	CONSTRAINT "return_exchange_line" CHECK("line_index" BETWEEN 0 AND 199),
	CONSTRAINT "return_exchange_target" CHECK(json_valid("target") AND json_type("target") IS 'object' AND json_type("target",'$.productId') IS 'text' AND length(json_extract("target",'$.productId')) BETWEEN 1 AND 128 AND json_type("target",'$.name') IS 'text' AND json_type("target",'$.priceMinor') IS 'integer' AND json_extract("target",'$.priceMinor') BETWEEN 1 AND 1000000000 AND json_type("target",'$.currency') IS 'text' AND length(json_extract("target",'$.currency'))=3 AND (json_type("target",'$.variantId') IS 'text' OR json_type("target",'$.variantId') IS 'null'))
);
