// src/order-items.ts
var IN_CHUNK = 90;
function chunked(values, size = IN_CHUNK) {
  const chunks = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}
var placeholders = (values) => values.map(() => "?").join(", ");
var ORDER_AMOUNT_COLUMNS = `subtotal_amount, discount_code, discount_amount, credit_applied, shipping_amount,
  shipping_label, tax_amount, tax_behavior, gift_card_applied, total_amount, provider_refunded_cents, gift_card_refunded_cents`;
function orderAmounts(row) {
  const amounts = [{ key: "itemsSubtotal", label: "Items subtotal", cents: row.subtotal_amount || row.total_amount }];
  if (row.discount_amount > 0) {
    amounts.push({ key: "discount", label: row.discount_code ? `Discount (${row.discount_code})` : "Discount", cents: -row.discount_amount });
  }
  if (row.credit_applied > 0) amounts.push({ key: "storeCredit", label: "Store credit", cents: -row.credit_applied });
  if (row.shipping_amount > 0 || row.shipping_label) {
    amounts.push({ key: "shipping", label: row.shipping_label ? `Shipping (${row.shipping_label})` : "Shipping", cents: row.shipping_amount });
  }
  if (row.tax_amount > 0) {
    amounts.push(row.tax_behavior === "inclusive" ? { key: "taxIncluded", label: "Tax included in the prices", cents: row.tax_amount } : { key: "tax", label: "Tax", cents: row.tax_amount });
  }
  if (row.gift_card_applied > 0) amounts.push({ key: "giftCard", label: "Gift card", cents: -row.gift_card_applied });
  amounts.push({ key: "charged", label: "Charged by the payment provider", cents: row.total_amount });
  if (row.provider_refunded_cents > 0) {
    amounts.push({ key: "providerRefunded", label: "Refunded by the payment provider", cents: row.provider_refunded_cents });
  }
  if (row.gift_card_refunded_cents > 0) {
    amounts.push({ key: "giftCardRefunded", label: "Refunded to the gift card", cents: row.gift_card_refunded_cents });
  }
  return amounts;
}
async function describeOrderItems(env, items) {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [item.variantId] : []))];
  const productChunks = chunked(productIds);
  const variantChunks = chunked(variantIds);
  const statements = [
    ...productChunks.map((ids) => env.DB.prepare(`SELECT id, name, sku FROM _ecommerce_products
      WHERE id IN (${placeholders(ids)})`).bind(...ids)),
    ...variantChunks.map((ids) => env.DB.prepare(`SELECT v.id, v.value, v.sku, g.name AS group_name,
        g.sku AS group_sku, d.name AS definition_name
      FROM _ecommerce_product_variant_values v
      JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id
      LEFT JOIN _ecommerce_variants d ON d.id = g.variant_id
      WHERE v.id IN (${placeholders(ids)})`).bind(...ids)),
    // A variant group without values is sold as itself.
    ...variantChunks.map((ids) => env.DB.prepare(`SELECT id, name, sku FROM _ecommerce_product_variants
      WHERE id IN (${placeholders(ids)})`).bind(...ids))
  ];
  const results = statements.length ? await env.DB.batch(statements) : [];
  const rowsOf = (from, count) => results.slice(from, from + count).flatMap((result) => result.results ?? []);
  const products = new Map(rowsOf(0, productChunks.length).map((row) => [row.id, row]));
  const values = new Map(rowsOf(productChunks.length, variantChunks.length).map((row) => [row.id, row]));
  const groups = new Map(rowsOf(productChunks.length + variantChunks.length, variantChunks.length).map((row) => [row.id, row]));
  return items.map((item) => {
    const product = products.get(item.productId);
    const value = item.variantId ? values.get(item.variantId) : void 0;
    const group = item.variantId && !value ? groups.get(item.variantId) : void 0;
    return {
      ...item,
      productName: product?.name ?? null,
      variantLabel: value ? `${value.definition_name ?? value.group_name}: ${value.value}` : group?.name ?? null,
      sku: (value ? value.sku || value.group_sku : group?.sku) || product?.sku || null
    };
  });
}

export {
  chunked,
  placeholders,
  ORDER_AMOUNT_COLUMNS,
  orderAmounts,
  describeOrderItems
};
