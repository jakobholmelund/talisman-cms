/** The one-time sign-in link. `link` carries the token in its fragment, so it never reaches server logs. */
declare function shopperSignInEmail({ link, siteName }: {
    link: string;
    siteName: string;
}): {
    html: string;
    text: string;
    kind: string;
    subject: string;
};
/** The store as the Worker settings describe it. */
interface CommerceEmailStore {
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
interface CommerceEmailMessage {
    subject: string;
    text: string;
    html?: string;
}
interface OrderEmailAddress {
    name?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
}
interface OrderConfirmationEmail {
    store: CommerceEmailStore;
    order: {
        id: string;
        placedAt: Date;
        currency: string;
        /** `name` is the product name and variant label as the catalog has them when the email is sent. */
        items: Array<{
            productId: string;
            variantId: string | null;
            name: string;
            productName: string | null;
            variantLabel: string | null;
            sku: string | null;
            quantity: number;
            unitCents: number;
            lineCents: number;
        }>;
        /**
         * The labelled amounts, as in the admin orders queue but worded for the buyer. Deductions are negative.
         * `taxIncluded` shows tax already inside the item prices: a template that adds the amounts up skips it.
         */
        amounts: Array<{
            key: string;
            label: string;
            cents: number;
        }>;
        shippingAddress: OrderEmailAddress | null;
    };
}
interface ShipmentEmail {
    store: CommerceEmailStore;
    order: {
        id: string;
        placedAt: Date;
    };
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
interface GiftCardClaimEmail {
    store: CommerceEmailStore;
    purchase: {
        id: string;
        amountCents: number;
        currency: string;
    };
    /** The one-time link that shows the code. It carries its token in the fragment. */
    claim: {
        url: string;
        expiresAt: Date;
    };
}
type Template<T> = (email: T, defaults: CommerceEmailMessage) => CommerceEmailMessage | Promise<CommerceEmailMessage>;
/** The exports of the module named by ecommercePlugin({ emailTemplates }). */
interface CommerceEmailTemplates {
    orderConfirmation?: Template<OrderConfirmationEmail>;
    shipment?: Template<ShipmentEmail>;
    giftCardClaim?: Template<GiftCardClaimEmail>;
}
/** An amount in minor units: `1250` in `usd` reads `$12.50` and in `jpy` `¥1,250`; deductions read `-$12.50`. */
declare function formatMoney(cents: number, currency: string): string;
/** A date such as `26 September 2026`, in UTC. */
declare function formatDate(date: Date): string;
/** The lines of a postal address, with the country's name for its two-letter code. */
declare function formatAddress(address: OrderEmailAddress | null): string[];
interface CommerceEmailSection {
    title?: string;
    /** Label and value pairs, such as an item and its price; `strong` marks a total. */
    rows?: Array<{
        label: string;
        value: string;
        strong?: boolean;
    }>;
    /** Lines shown one below the other, such as an address. */
    lines?: string[];
    links?: Array<{
        label: string;
        url: string;
    }>;
}
interface CommerceEmailContent {
    storeName: string;
    heading: string;
    paragraphs: string[];
    /** A button; the URL is also shown as text. */
    action?: {
        label: string;
        url: string;
    };
    sections?: CommerceEmailSection[];
    footer?: string[];
}
/** Links in mail must be https:, except http: on localhost for development. */
declare function emailLink(url: string): string | null;
/**
 * A plain-text part and an inline-styled HTML part, in the look of the CMS's transactional emails,
 * built from the same content. Every value is escaped in the HTML; links that are not https (or
 * http on localhost) are left out.
 */
declare function renderCommerceEmail(content: CommerceEmailContent): {
    text: string;
    html: string;
};
/** The default order confirmation: what was bought, what was paid, where it goes, and who sold it. */
declare function orderConfirmationEmail({ store, order }: OrderConfirmationEmail): CommerceEmailMessage;
/** The default shipment notice, or the updated notice after a correction. */
declare function shipmentEmail({ store, order, shipment, update }: ShipmentEmail): CommerceEmailMessage;
/** The default gift card email: a one-time link to the code, never the code itself. */
declare function giftCardClaimEmail({ store, purchase, claim }: GiftCardClaimEmail): CommerceEmailMessage;

export { type CommerceEmailContent, type CommerceEmailMessage, type CommerceEmailSection, type CommerceEmailStore, type CommerceEmailTemplates, type GiftCardClaimEmail, type OrderConfirmationEmail, type OrderEmailAddress, type ShipmentEmail, emailLink, formatAddress, formatDate, formatMoney, giftCardClaimEmail, orderConfirmationEmail, renderCommerceEmail, shipmentEmail, shopperSignInEmail };
