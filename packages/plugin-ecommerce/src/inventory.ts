/**
 * The stock column checkout reserves from and releases to, by reservation target type. Restocking a
 * refunded order returns stock to the same columns.
 */
export const INVENTORY_COLUMNS = {
  product: ['_ecommerce_products', 'inventory_quantity'],
  variant: ['_ecommerce_product_variants', 'inventory_quantity'],
  stock: ['_ecommerce_stocks', 'quantity'],
} as const;
