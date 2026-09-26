import { escapeHtml, renderTransactionalEmail } from 'talisman-cms/email';
import { formatMoney as formatMinorUnits } from './money';

/** The one-time sign-in link. `link` carries the token in its fragment, so it never reaches server logs. */
export function shopperSignInEmail({ link, siteName }: { link: string; siteName: string }) {
  return {
    kind: 'shopper-sign-in',
    subject: `Sign in to ${siteName}`.replace(/[\r\n]+/g, ' '),
    ...renderTransactionalEmail({
      siteName,
      heading: 'Your sign-in link',
      paragraphs: ['Use this one-time link to sign in. It expires in 15 minutes and works once.'],
      action: { label: 'Sign in', url: link },
      footer: "If you didn't ask to sign in, you can ignore this email.",
    }),
  };
}

// --- Order, shipment and gift card emails ---------------------------------------------------------
//
// Stores can replace any of these templates with ecommercePlugin({ emailTemplates }): a module that
// exports `orderConfirmation`, `shipment` and `giftCardClaim`, each optional. Each is called with the
// email's data and the default message, and returns `{ subject, text, html? }`, or a promise of it.
// A template that throws or returns something else is logged and the default is sent instead.

/** The store as the Worker settings describe it. */
export interface CommerceEmailStore {
  /** `TALISMAN_COMMERCE_STORE_NAME`, else the sender's display name, else the public origin's host. */
  name: string;
  /** `TALISMAN_COMMERCE_STORE_LEGAL_NAME`. */
  legalName: string | null;
  /** `TALISMAN_COMMERCE_STORE_ADDRESS`, one entry per line. */
  address: string[];
  /** `TALISMAN_COMMERCE_SUPPORT_EMAIL`, else the address of `TALISMAN_EMAIL_REPLY_TO`. */
  supportEmail: string | null;
  /** `TALISMAN_COMMERCE_TERMS_URL`, `TALISMAN_COMMERCE_RETURNS_URL` and `TALISMAN_COMMERCE_WARRANTY_URL`, as absolute URLs. */
  termsUrl: string | null;
  returnsUrl: string | null;
  warrantyUrl: string | null;
  /** `TALISMAN_COMMERCE_PUBLIC_ORIGIN`, else `TALISMAN_PUBLIC_ORIGIN`. */
  origin: string | null;
}

/** What a template returns. The subject is one line; the plain-text part is required. */
export interface CommerceEmailMessage {
  subject: string;
  text: string;
  html?: string;
}

export interface OrderEmailAddress {
  name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string;
}

export interface OrderConfirmationEmail {
  store: CommerceEmailStore;
  order: {
    id: string;
    placedAt: Date;
    currency: string;
    /** `name` is the product name and variant label as the catalog has them when the email is sent. */
    items: Array<{ productId: string; variantId: string | null; name: string; productName: string | null;
      variantLabel: string | null; sku: string | null; quantity: number; unitCents: number; lineCents: number }>;
    /**
     * The labelled amounts, as in the admin orders queue but worded for the buyer. Deductions are negative.
     * `taxIncluded` shows tax already inside the item prices: a template that adds the amounts up skips it.
     */
    amounts: Array<{ key: string; label: string; cents: number }>;
    shippingAddress: OrderEmailAddress | null;
  };
}

export interface ShipmentEmail {
  store: CommerceEmailStore;
  order: { id: string; placedAt: Date };
  shipment: {
    id: string;
    shippedAt: Date;
    /** The carrier and tracking number in force: a correction replaces the ones first recorded. */
    carrier: string | null;
    trackingNumber: string | null;
    /** False while more parcels of the order are to follow. */
    completesOrder: boolean;
    /** Parcels of the order recorded before this one. */
    earlierShipments: number;
  };
  /** True for the notice sent after a correction changed the carrier or tracking number. */
  update: boolean;
}

export interface GiftCardClaimEmail {
  store: CommerceEmailStore;
  purchase: { id: string; amountCents: number; currency: string };
  /** The one-time link that shows the code. It carries its token in the fragment. */
  claim: { url: string; expiresAt: Date };
}

type Template<T> = (email: T, defaults: CommerceEmailMessage) => CommerceEmailMessage | Promise<CommerceEmailMessage>;

/** The exports of the module named by ecommercePlugin({ emailTemplates }). */
export interface CommerceEmailTemplates {
  orderConfirmation?: Template<OrderConfirmationEmail>;
  shipment?: Template<ShipmentEmail>;
  giftCardClaim?: Template<GiftCardClaimEmail>;
}

/** An amount in minor units: `1250` in `usd` reads `$12.50` and in `jpy` `¥1,250`; deductions read `-$12.50`. */
export function formatMoney(cents: number, currency: string) {
  try {
    return formatMinorUnits(cents, currency);
  } catch {
    // Only a code Intl does not know gets here; store currencies are all known (money.ts).
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** A date such as `26 September 2026`, in UTC. */
export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function countryName(code: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** The lines of a postal address, with the country's name for its two-letter code. */
export function formatAddress(address: OrderEmailAddress | null) {
  if (!address) return [];
  const town = [address.city, address.state, address.postalCode].map((part) => part?.trim()).filter(Boolean).join(', ');
  return [address.name, address.line1, address.line2, town, address.country && countryName(address.country)]
    .map((line) => line?.trim()).filter((line): line is string => Boolean(line));
}

export interface CommerceEmailSection {
  title?: string;
  /** Label and value pairs, such as an item and its price; `strong` marks a total. */
  rows?: Array<{ label: string; value: string; strong?: boolean }>;
  /** Lines shown one below the other, such as an address. */
  lines?: string[];
  links?: Array<{ label: string; url: string }>;
}

export interface CommerceEmailContent {
  storeName: string;
  heading: string;
  paragraphs: string[];
  /** A button; the URL is also shown as text. */
  action?: { label: string; url: string };
  sections?: CommerceEmailSection[];
  footer?: string[];
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Links in mail must be https:, except http: on localhost for development. */
export function emailLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOCAL_HOSTNAMES.has(parsed.hostname))) return parsed.href;
  } catch {
    // Reported below.
  }
  return null;
}

/**
 * A plain-text part and an inline-styled HTML part, in the look of the CMS's transactional emails,
 * built from the same content. Every value is escaped in the HTML; links that are not https (or
 * http on localhost) are left out.
 */
export function renderCommerceEmail(content: CommerceEmailContent): { text: string; html: string } {
  const action = content.action && emailLink(content.action.url) ? { ...content.action, url: emailLink(content.action.url)! } : null;
  const sections = (content.sections ?? []).map((section) => ({ ...section,
    links: (section.links ?? []).flatMap((link) => emailLink(link.url) ? [{ label: link.label, url: emailLink(link.url)! }] : []) }))
    .filter((section) => section.rows?.length || section.lines?.length || section.links.length);
  const text = [
    content.heading,
    ...content.paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    ...sections.map((section) => [
      ...(section.title ? [section.title] : []),
      ...(section.rows ?? []).map((row) => `${row.label}: ${row.value}`),
      ...(section.lines ?? []),
      ...section.links.map((link) => `${link.label}: ${link.url}`),
    ].join('\n')),
    ...(content.footer ?? []),
    content.storeName,
  ].join('\n\n');

  const muted = 'color:#5b635d;font-size:13px';
  const cell = 'padding:4px 0;vertical-align:top';
  const html = [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f5f2;color:#1f2420;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;line-height:1.6">',
    '<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">',
    `<p style="margin:0 0 24px;${muted}">${escapeHtml(content.storeName)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`),
    ...(action ? [
      `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f2420;color:#ffffff;text-decoration:none">${escapeHtml(action.label)}</a></p>`,
      `<p style="margin:0 0 16px;${muted};word-break:break-all">${escapeHtml(action.url)}</p>`,
    ] : []),
    ...sections.flatMap((section) => [
      ...(section.title ? [`<h2 style="margin:24px 0 8px;font-size:16px;line-height:1.3">${escapeHtml(section.title)}</h2>`] : []),
      ...(section.rows?.length ? [`<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">${section.rows.map((row) => {
        const weight = row.strong ? ';font-weight:700' : '';
        return `<tr><td style="${cell};padding-right:16px${weight}">${escapeHtml(row.label)}</td><td style="${cell};text-align:right;white-space:nowrap${weight}">${escapeHtml(row.value)}</td></tr>`;
      }).join('')}</table>`] : []),
      ...(section.lines?.length ? [`<p style="margin:0 0 16px">${section.lines.map(escapeHtml).join('<br>')}</p>`] : []),
      ...section.links.map((link) => `<p style="margin:0 0 8px"><a href="${escapeHtml(link.url)}" style="color:#1f2420">${escapeHtml(link.label)}</a></p>`),
    ]),
    ...(content.footer ?? []).map((line) => `<p style="margin:24px 0 0;${muted}">${escapeHtml(line)}</p>`),
    '</div></body></html>',
  ].join('\n');
  return { text, html };
}

const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** Who the seller is and where the buyer finds the terms: the store details that are configured. */
function storeSections(store: CommerceEmailStore): CommerceEmailSection[] {
  return [
    { title: 'Seller', lines: [store.legalName ?? store.name, ...store.address,
      ...(store.supportEmail ? [`Email: ${store.supportEmail}`] : [])] },
    { title: 'Terms and your rights', links: [
      ...(store.termsUrl ? [{ label: 'Terms of sale', url: store.termsUrl }] : []),
      ...(store.returnsUrl ? [{ label: 'Returns and right of withdrawal', url: store.returnsUrl }] : []),
      ...(store.warrantyUrl ? [{ label: 'Warranty', url: store.warrantyUrl }] : []),
    ] },
  ];
}

const contact = (store: CommerceEmailStore) => store.supportEmail ? `write to ${store.supportEmail}` : `contact ${store.name}`;

/** The default order confirmation: what was bought, what was paid, where it goes, and who sold it. */
export function orderConfirmationEmail({ store, order }: OrderConfirmationEmail): CommerceEmailMessage {
  const money = (cents: number) => formatMoney(cents, order.currency);
  const shippingLines = formatAddress(order.shippingAddress);
  return {
    subject: oneLine(`Your ${store.name} order is confirmed`),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: 'Thank you for your order',
      paragraphs: [
        `We have received your payment for order ${order.id}, placed on ${formatDate(order.placedAt)}.`,
        'This email confirms your order. Please keep it for your records.',
      ],
      sections: [
        { title: 'Items', rows: order.items.map((item) => ({ label: `${item.quantity} × ${item.name}`, value: money(item.lineCents) })) },
        { title: 'Payment', rows: order.amounts.map((amount) => ({ label: amount.label, value: money(amount.cents),
          strong: amount.key === 'charged' })) },
        ...(shippingLines.length ? [{ title: 'Shipping to', lines: shippingLines }] : []),
        ...storeSections(store),
      ],
      footer: [`Questions about your order? Please ${contact(store)} and mention the order number.`],
    }),
  };
}

/** The default shipment notice, or the updated notice after a correction. */
export function shipmentEmail({ store, order, shipment, update }: ShipmentEmail): CommerceEmailMessage {
  const shippedOn = formatDate(shipment.shippedAt);
  // The whole order in one parcel, one parcel with more to follow, or the last of several.
  const part = !shipment.completesOrder ? 'part' : shipment.earlierShipments ? 'rest' : 'whole';
  const paragraphs = update
    ? [`The shipping details of a parcel of order ${order.id} have changed. They replace the ones we sent you before.`]
    : {
      whole: [`We shipped your order ${order.id} on ${shippedOn}.`],
      part: [`We shipped a parcel of your order ${order.id} on ${shippedOn}.`, 'More parcels will follow.'],
      rest: [`We shipped the last parcel of your order ${order.id} on ${shippedOn}.`],
    }[part];
  const rows = [
    ...(shipment.carrier ? [{ label: 'Carrier', value: shipment.carrier }] : []),
    ...(shipment.trackingNumber ? [{ label: 'Tracking number', value: shipment.trackingNumber }] : []),
  ];
  if (!shipment.trackingNumber) paragraphs.push('This parcel has no tracking number.');
  return {
    subject: oneLine(update ? `Updated shipping details for your ${store.name} order` : {
      whole: `Your ${store.name} order has shipped`,
      part: `Part of your ${store.name} order has shipped`,
      rest: `The rest of your ${store.name} order has shipped`,
    }[part]),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: update ? 'Updated shipping details' : {
        whole: 'Your order is on its way', part: 'Part of your order is on its way', rest: 'The rest of your order is on its way',
      }[part],
      paragraphs,
      sections: rows.length ? [{ title: 'Shipment', rows }] : [],
      footer: [`Questions about your delivery? Please ${contact(store)} and mention the order number.`],
    }),
  };
}

/** The default gift card email: a one-time link to the code, never the code itself. */
export function giftCardClaimEmail({ store, purchase, claim }: GiftCardClaimEmail): CommerceEmailMessage {
  return {
    subject: oneLine(`Your ${store.name} gift card`),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: 'Your gift card is ready',
      paragraphs: [
        `Thank you for buying a ${formatMoney(purchase.amountCents, purchase.currency)} gift card from ${store.name}. Use the link below to show its code. The link works once and expires on ${formatDate(claim.expiresAt)}.`,
        'Anyone who has the code can spend its balance, so share it only with the person you are giving it to.',
      ],
      action: { label: 'Show the gift card code', url: claim.url },
      footer: [`If the link has expired or was already used, please ${contact(store)} and ask for a new one.`],
    }),
  };
}
