DELETE FROM `_ecommerce_stocks` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_product_variant_values` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_product_variants` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_product_tags` WHERE `product_id` LIKE 'demo_%' OR `tag_id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_product_categories` WHERE `product_id` LIKE 'demo_%' OR `category_id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_products` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_variants` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_tags` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `_ecommerce_categories` WHERE `id` LIKE 'demo_%';
--> statement-breakpoint
DELETE FROM `galaxy_entries` WHERE `id` LIKE 'demo_post_%' OR `id` LIKE 'demo_author_%';
--> statement-breakpoint

INSERT INTO `galaxy_collections` (`id`, `name`, `slug`, `description`, `fields`, `created_at`)
VALUES
  (
    'demo_collection_authors',
    'Authors',
    'authors',
    'Authors for the blog',
    '[{"name":"name","label":"Name","type":"text","required":true}]',
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_collection_posts',
    'Posts',
    'posts',
    'Blog posts and articles',
    '[{"name":"title","label":"Title","type":"text","required":true},{"name":"author","label":"Author","type":"relationship","relationTo":"authors"},{"name":"content","label":"Content","type":"richtext"},{"name":"views","label":"Views","type":"number","defaultValue":0},{"name":"isPublished","label":"Published","type":"boolean","defaultValue":false},{"name":"publishedAt","label":"Published Date","type":"date"}]',
    (strftime('%s','now') * 1000)
  ),
  ('demo_collection_products', 'Products', 'products', 'Catalog of items available for purchase', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_variants', 'Variants', '_ecommerce_variants', 'Reusable variant definitions such as Size or Color', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_product_variants', 'Product Variant Groups', '_ecommerce_product_variants', 'Assigns a reusable variant definition to a product', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_product_variant_values', 'Product Variant Values', '_ecommerce_product_variant_values', 'Purchasable values for each product variant group', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_stocks', 'Stock Levels', '_ecommerce_stocks', 'Inventory rows for product variant values', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_categories', 'Categories', '_ecommerce_categories', 'Product categories', '[]', (strftime('%s','now') * 1000)),
  ('demo_collection_ecommerce_tags', 'Product Tags', '_ecommerce_tags', 'Custom tags for grouping products', '[]', (strftime('%s','now') * 1000))
ON CONFLICT(`slug`) DO UPDATE SET
  `name` = excluded.`name`,
  `description` = excluded.`description`,
  `fields` = excluded.`fields`;
--> statement-breakpoint

INSERT INTO `galaxy_entries` (`id`, `collection_id`, `slug`, `status`, `data`, `published_data`, `created_at`, `updated_at`, `published_at`)
VALUES
  (
    'demo_author_galaxy_team',
    (SELECT `id` FROM `galaxy_collections` WHERE `slug` = 'authors'),
    'talisman-team',
    'published',
    '{"name":"Talisman Team"}',
    '{"name":"Talisman Team"}',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_author_jakob',
    (SELECT `id` FROM `galaxy_collections` WHERE `slug` = 'authors'),
    'jakob',
    'published',
    '{"name":"Jakob"}',
    '{"name":"Jakob"}',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_post_first_storefront',
    (SELECT `id` FROM `galaxy_collections` WHERE `slug` = 'posts'),
    'first-storefront-pass',
    'published',
    '{"title":"Building the First Storefront Pass","author":"demo_author_galaxy_team","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The ecommerce plugin now ships with a seeded storefront, normalized variants, and stock-aware checkout hooks."}]},{"type":"paragraph","content":[{"type":"text","text":"Use this demo post to verify standard collection entries render next to the native ecommerce catalog."}]}]},"views":128,"isPublished":true,"publishedAt":"2026-03-14T00:00:00.000Z"}',
    '{"title":"Building the First Storefront Pass","author":"demo_author_galaxy_team","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The ecommerce plugin now ships with a seeded storefront, normalized variants, and stock-aware checkout hooks."}]},{"type":"paragraph","content":[{"type":"text","text":"Use this demo post to verify standard collection entries render next to the native ecommerce catalog."}]}]},"views":128,"isPublished":true,"publishedAt":"2026-03-14T00:00:00.000Z"}',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_post_local_d1',
    (SELECT `id` FROM `galaxy_collections` WHERE `slug` = 'posts'),
    'local-d1-seeding-notes',
    'published',
    '{"title":"Local D1 Seeding Notes","author":"demo_author_jakob","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Local development uses the D1 database bound in Wrangler, so migrations and seeds need to be applied there before the playground can read them."}]},{"type":"paragraph","content":[{"type":"text","text":"If the page looks empty after reseeding, restart the dev server so the worker reloads the latest config and bindings."}]}]},"views":87,"isPublished":true,"publishedAt":"2026-03-13T00:00:00.000Z"}',
    '{"title":"Local D1 Seeding Notes","author":"demo_author_jakob","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Local development uses the D1 database bound in Wrangler, so migrations and seeds need to be applied there before the playground can read them."}]},{"type":"paragraph","content":[{"type":"text","text":"If the page looks empty after reseeding, restart the dev server so the worker reloads the latest config and bindings."}]}]},"views":87,"isPublished":true,"publishedAt":"2026-03-13T00:00:00.000Z"}',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  );
--> statement-breakpoint

INSERT INTO `_ecommerce_categories` (`id`, `name`, `slug`, `description`, `image`, `parent_id`, `created_at`, `updated_at`)
VALUES
  ('demo_cat_boards', 'Boards', 'boards', 'Decks, completes, and rider-ready setups.', 'https://images.unsplash.com/photo-1547447134-cd3f5c716030?auto=format&fit=crop&w=1200&q=80', NULL, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_cat_apparel', 'Apparel', 'apparel', 'Soft goods, outerwear, and everyday carry pieces.', 'https://images.unsplash.com/photo-1523398002811-999ca8dec234?auto=format&fit=crop&w=1200&q=80', NULL, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_cat_digital', 'Digital Goods', 'digital-goods', 'Downloads and members-only extras.', 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80', NULL, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint

INSERT INTO `_ecommerce_tags` (`id`, `name`, `color`, `created_at`, `updated_at`)
VALUES
  ('demo_tag_featured', 'Featured', 'emerald', (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_tag_limited', 'Limited', 'amber', (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_tag_starter', 'Starter', 'sky', (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint

INSERT INTO `_ecommerce_products` (`id`, `name`, `slug`, `sku`, `description`, `images`, `category_ids`, `tag_ids`, `base_price`, `is_physical`, `inventory_quantity`, `type`, `status`, `created_at`, `updated_at`)
VALUES
  (
    'demo_prod_nebula_deck',
    'Nebula Deck',
    'nebula-deck',
    'DEMO-NEBULA-DECK',
    'A responsive maple deck with three width options, tuned for all-around park sessions.',
    json_array('https://images.unsplash.com/photo-1547447134-cd3f5c716030?auto=format&fit=crop&w=1200&q=80'),
    json_array('demo_cat_boards'),
    json_array('demo_tag_featured', 'demo_tag_starter'),
    12900,
    true,
    12,
    'standard',
    'active',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_prod_signal_cap',
    'Signal Cap',
    'signal-cap',
    'DEMO-SIGNAL-CAP',
    'A low-profile six-panel cap with color options and enough stock to test inventory flows.',
    json_array('https://images.unsplash.com/photo-1514327605112-b887c0e61c0a?auto=format&fit=crop&w=1200&q=80'),
    json_array('demo_cat_apparel'),
    json_array('demo_tag_featured', 'demo_tag_limited'),
    3400,
    true,
    16,
    'standard',
    'active',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  ),
  (
    'demo_prod_star_map',
    'Star Map Download',
    'star-map-download',
    'DEMO-STAR-MAP',
    'A digital poster pack with layered exports for print, wallpaper, and social use.',
    json_array('https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80'),
    json_array('demo_cat_digital'),
    json_array('demo_tag_limited'),
    2400,
    false,
    999,
    'digital',
    'active',
    (strftime('%s','now') * 1000),
    (strftime('%s','now') * 1000)
  );
--> statement-breakpoint

INSERT INTO `_ecommerce_product_categories` (`product_id`, `category_id`)
VALUES
  ('demo_prod_nebula_deck', 'demo_cat_boards'),
  ('demo_prod_signal_cap', 'demo_cat_apparel'),
  ('demo_prod_star_map', 'demo_cat_digital');
--> statement-breakpoint

INSERT INTO `_ecommerce_product_tags` (`product_id`, `tag_id`)
VALUES
  ('demo_prod_nebula_deck', 'demo_tag_featured'),
  ('demo_prod_nebula_deck', 'demo_tag_starter'),
  ('demo_prod_signal_cap', 'demo_tag_featured'),
  ('demo_prod_signal_cap', 'demo_tag_limited'),
  ('demo_prod_star_map', 'demo_tag_limited');
--> statement-breakpoint

INSERT INTO `_ecommerce_variants` (`id`, `name`, `created_at`, `updated_at`)
VALUES
  ('demo_variant_size', 'Size', (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_variant_color', 'Color', (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint

INSERT INTO `_ecommerce_product_variants` (`id`, `product_id`, `variant_id`, `name`, `sku`, `price_override`, `inventory_quantity`, `created_at`, `updated_at`)
VALUES
  ('demo_pv_nebula_size', 'demo_prod_nebula_deck', 'demo_variant_size', 'Deck Width', NULL, NULL, 12, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pv_signal_color', 'demo_prod_signal_cap', 'demo_variant_color', 'Cap Color', NULL, NULL, 16, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint

INSERT INTO `_ecommerce_product_variant_values` (`id`, `product_variant_id`, `value`, `sku`, `price_override`, `created_at`, `updated_at`)
VALUES
  ('demo_pvv_nebula_80', 'demo_pv_nebula_size', '8.0"', 'DEMO-NEBULA-80', 12900, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pvv_nebula_825', 'demo_pv_nebula_size', '8.25"', 'DEMO-NEBULA-825', 13500, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pvv_nebula_85', 'demo_pv_nebula_size', '8.5"', 'DEMO-NEBULA-85', 13900, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pvv_signal_black', 'demo_pv_signal_color', 'Black', 'DEMO-SIGNAL-BLK', 3400, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pvv_signal_sand', 'demo_pv_signal_color', 'Sand', 'DEMO-SIGNAL-SND', 3400, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_pvv_signal_cobalt', 'demo_pv_signal_color', 'Cobalt', 'DEMO-SIGNAL-CBL', 3600, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint

INSERT INTO `_ecommerce_stocks` (`id`, `product_variant_value_id`, `quantity`, `created_at`, `updated_at`)
VALUES
  ('demo_stock_nebula_80', 'demo_pvv_nebula_80', 4, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_stock_nebula_825', 'demo_pvv_nebula_825', 5, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_stock_nebula_85', 'demo_pvv_nebula_85', 3, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_stock_signal_black', 'demo_pvv_signal_black', 8, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_stock_signal_sand', 'demo_pvv_signal_sand', 5, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)),
  ('demo_stock_signal_cobalt', 'demo_pvv_signal_cobalt', 3, (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
