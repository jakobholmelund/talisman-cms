/**
 * The store currency, from the talisman-commerce-currency meta tag that the admin page renders from
 * TALISMAN_COMMERCE_CURRENCY. Commerce prices are integers in its minor units. USD when unset.
 */
export function readCommerceCurrency() {
  const content = typeof document === 'undefined' ? undefined
    : document.querySelector('meta[name="talisman-commerce-currency"]')?.getAttribute('content')?.trim().toLowerCase();
  return content && /^[a-z]{3}$/.test(content) ? content : 'usd';
}
