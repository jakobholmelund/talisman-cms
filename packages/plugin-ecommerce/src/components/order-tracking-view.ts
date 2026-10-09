import type { CustomerOrderTracking } from '@talisman-cms/plugin-ecommerce/browser';
/** Every catalog and tracking value is text, never interpreted as markup or a carrier URL. */
export function renderOrderTracking(root: HTMLElement, data: CustomerOrderTracking) {
  const fragment = document.createDocumentFragment();
  const add = (parent: Node, tag: string, text: string) => { const node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node; };
  add(fragment, 'h3', 'Items still to ship');
  if (data.lines.some(l => l.remaining === null)) add(fragment, 'p', 'Item counts for earlier parcels are unavailable. Contact the store for the remaining items.');
  else {
    const remaining = data.lines.filter(l => (l.remaining ?? 0) > 0);
    if (!remaining.length) add(fragment, 'p', 'All item quantities have been recorded as shipped.');
    else { const list = add(fragment, 'ul', ''); for (const l of remaining) add(list, 'li', `${l.remaining} × ${l.name}`); }
  }
  add(fragment, 'h3', 'Your parcels');
  if (!data.parcels.length) add(fragment, 'p', 'No parcels have been recorded yet.');
  for (const [index, parcel] of data.parcels.entries()) {
    const article = add(fragment, 'article', '');
    add(article, 'h4', `Parcel ${index + 1} · ${new Date(parcel.shippedAt).toLocaleDateString()}`);
    add(article, 'p', [parcel.carrier, parcel.trackingNumber ? `Tracking: ${parcel.trackingNumber}` : 'Tracking number not provided'].filter(Boolean).join(' · '));
    if (parcel.items === null) add(article, 'p', 'Item quantities for this earlier parcel are unavailable.');
    else { const list = add(article, 'ul', ''); for (const item of parcel.items) add(list, 'li', `${item.quantity} × ${item.name}${item.sku ? ` · ${item.sku}` : ''}`); }
  }
  add(fragment, 'h3', 'Received returns');
  if (!data.returns.length) add(fragment, 'p', 'No returned items have been received yet.');
  for (const receipt of data.returns) {
    const article = add(fragment, 'article', ''); add(article, 'p', `Received ${new Date(receipt.receivedAt).toLocaleDateString()}`);
    const list = add(article, 'ul', '');
    for (const item of receipt.items) add(list, 'li', `${item.quantity} × ${item.name} · ${item.awaitingInspection ? `${item.awaitingInspection} awaiting inspection` : 'Review complete'}`);
  }
  if (data.returns.length) add(fragment, 'p', 'Return receipt and inspection are separate from any payment refund.');
  root.replaceChildren(fragment);
}
