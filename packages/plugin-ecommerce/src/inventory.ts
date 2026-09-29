import { components, productVariants, products, stocks } from './schema';

/**
 * The stock column checkout reserves from and releases to, by reservation target type, as the
 * schema's table and column: a stock statement names them through these, never as text. Restocking a
 * refunded order returns stock to the same columns; `component` is the target of component reservations.
 */
export const INVENTORY_COLUMNS = {
  product: { table: products, quantity: products.inventoryQuantity },
  variant: { table: productVariants, quantity: productVariants.inventoryQuantity },
  stock: { table: stocks, quantity: stocks.quantity },
} as const;

/** Every stock column a restock may return to: the inventory columns and the components' quantity. */
export const STOCK_COLUMNS = {
  ...INVENTORY_COLUMNS,
  component: { table: components, quantity: components.quantity },
} as const;
