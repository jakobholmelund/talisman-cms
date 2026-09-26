import type { TalismanEnv } from 'talisman-cms/client';
import { PURCHASED_ORDER_STATUSES } from './accounts';

/** Domains whose mailboxes ignore dots in the local part and share one inbox. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address that identifies one mailbox when shoppers are compared, or null when `email` has no
 * local part and domain. Lowercased and trimmed; a `+suffix` on the local part is dropped for every
 * domain; for gmail.com and googlemail.com dots in the local part are dropped too and the domain
 * becomes gmail.com. Only for comparisons: mail is always sent to the address the shopper gave.
 */
export function canonicalEmail(email: string | null | undefined) {
  if (typeof email !== 'string') return null;
  const address = email.trim().toLowerCase();
  const at = address.indexOf('@');
  if (at < 1) return null;
  const domain = address.slice(at + 1).replace(/\.+$/, '');
  if (!domain) return null;
  let local = address.slice(0, at);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) return `${local.replaceAll('.', '')}@gmail.com`;
  return `${local}@${domain}`;
}

/** The distinct canonical forms of the addresses that are set. */
export function canonicalEmails(emails: Array<string | null | undefined>) {
  return [...new Set(emails.map(canonicalEmail).filter((email): email is string => Boolean(email)))];
}

/**
 * SQL for the canonical form of the address in the column or expression `address`, or NULL when it has
 * no local part and domain. It follows `canonicalEmail` for ASCII addresses; SQLite's lower() leaves
 * other letters as they are.
 */
export function canonicalEmailSql(address: string) {
  const email = `lower(trim(${address}))`;
  const at = `instr(${email}, '@')`;
  const local = `substr(${email}, 1, ${at} - 1)`;
  const domain = `rtrim(substr(${email}, ${at} + 1), '.')`;
  const base = `(CASE WHEN instr(${local}, '+') > 1 THEN substr(${local}, 1, instr(${local}, '+') - 1) ELSE ${local} END)`;
  return `(CASE WHEN ${at} < 2 OR ${domain} = '' THEN NULL
    WHEN ${domain} IN ('gmail.com', 'googlemail.com') THEN replace(${base}, '.', '') || '@gmail.com'
    ELSE ${base} || '@' || ${domain} END)`;
}

/**
 * SQL `EXISTS (...)` that holds when a purchase other than order `?` was made under an address whose
 * canonical form is one of `count` bound values: the order's checkout email or its account's email.
 * Purchases are the statuses in PURCHASED_ORDER_STATUSES, never admin test orders. It binds the
 * excluded order ID twice, then the canonical addresses; `canonicalPurchaseParams` builds that list.
 */
export function canonicalPurchaseSql(count: number) {
  const statuses = PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(', ');
  const purchased = `o.status IN (${statuses}) AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test' AND o.id <> ?`;
  return `EXISTS (SELECT 1 FROM (
      SELECT o.customer_email AS address FROM _ecommerce_orders o WHERE ${purchased}
      UNION ALL
      SELECT a.email_normalized FROM _ecommerce_orders o
        JOIN _ecommerce_customer_accounts a ON a.id = o.user_id WHERE ${purchased})
    WHERE ${canonicalEmailSql('address')} IN (${Array.from({ length: count }, () => '?').join(', ')}))`;
}

export function canonicalPurchaseParams(canonicals: string[], excludeOrderId?: string | null) {
  return [excludeOrderId ?? '', excludeOrderId ?? '', ...canonicals];
}

/**
 * Whether any of `emails` belongs to a shopper who has already bought, after canonicalizing both
 * sides. Complements the exact match in `hasPurchaseHistory`.
 */
export async function hasCanonicalPurchase(env: TalismanEnv, emails: Array<string | null | undefined>,
  excludeOrderId?: string | null) {
  const canonicals = canonicalEmails(emails);
  if (!canonicals.length) return false;
  const found = await env.DB.prepare(`SELECT ${canonicalPurchaseSql(canonicals.length)} AS found`)
    .bind(...canonicalPurchaseParams(canonicals, excludeOrderId)).first<{ found: number }>();
  return Boolean(found?.found);
}
