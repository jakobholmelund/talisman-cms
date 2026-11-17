export type StockTarget = { type: 'product' | 'variant' | 'stock' | 'component'; id: string };
/** A navigation hint only. Stock tools load an authorized, current quantity and version before writes. */
export function stockTarget(hash: string): StockTarget | null {
  if (hash.length > 500) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.getAll('stockType').length !== 1 || params.getAll('stockId').length !== 1) return null;
  const type = params.get('stockType'), id = params.get('stockId');
  if (!['product', 'variant', 'stock', 'component'].includes(type ?? '') || !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return { type: type as StockTarget['type'], id };
}
