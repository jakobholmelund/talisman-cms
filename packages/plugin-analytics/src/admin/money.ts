/**
 * An order amount as text. Amounts are integers in the currency's minor units, as Intl formats the
 * currency: cents for USD, yen for JPY (no decimals) and fils for KWD (three decimals).
 */
export function formatMoney(amount: number, currency: string, locale?: string) {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() });
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}
