import {
  formatMoney
} from "./chunk-2UYSCNNW.js";

// src/emails.ts
import { escapeHtml, renderTransactionalEmail } from "talisman-cms/email";
function shopperSignInEmail({ link, siteName }) {
  return {
    kind: "shopper-sign-in",
    subject: `Sign in to ${siteName}`.replace(/[\r\n]+/g, " "),
    ...renderTransactionalEmail({
      siteName,
      heading: "Your sign-in link",
      paragraphs: ["Use this one-time link to sign in. It expires in 15 minutes and works once."],
      action: { label: "Sign in", url: link },
      footer: "If you didn't ask to sign in, you can ignore this email."
    })
  };
}
function formatMoney2(cents, currency) {
  try {
    return formatMoney(cents, currency);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
function countryName(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
function formatAddress(address) {
  if (!address) return [];
  const town = [address.city, address.state, address.postalCode].map((part) => part?.trim()).filter(Boolean).join(", ");
  return [address.name, address.line1, address.line2, town, address.country && countryName(address.country)].map((line) => line?.trim()).filter((line) => Boolean(line));
}
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function emailLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:" && LOCAL_HOSTNAMES.has(parsed.hostname)) return parsed.href;
  } catch {
  }
  return null;
}
function renderCommerceEmail(content) {
  const action = content.action && emailLink(content.action.url) ? { ...content.action, url: emailLink(content.action.url) } : null;
  const sections = (content.sections ?? []).map((section) => ({
    ...section,
    links: (section.links ?? []).flatMap((link) => emailLink(link.url) ? [{ label: link.label, url: emailLink(link.url) }] : [])
  })).filter((section) => section.rows?.length || section.lines?.length || section.links.length);
  const text = [
    content.heading,
    ...content.paragraphs,
    ...action ? [`${action.label}: ${action.url}`] : [],
    ...sections.map((section) => [
      ...section.title ? [section.title] : [],
      ...(section.rows ?? []).map((row) => `${row.label}: ${row.value}`),
      ...section.lines ?? [],
      ...section.links.map((link) => `${link.label}: ${link.url}`)
    ].join("\n")),
    ...content.footer ?? [],
    content.storeName
  ].join("\n\n");
  const muted = "color:#5b635d;font-size:13px";
  const cell = "padding:4px 0;vertical-align:top";
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#f5f5f2;color:#1f2420;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.6">`,
    '<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">',
    `<p style="margin:0 0 24px;${muted}">${escapeHtml(content.storeName)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`),
    ...action ? [
      `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f2420;color:#ffffff;text-decoration:none">${escapeHtml(action.label)}</a></p>`,
      `<p style="margin:0 0 16px;${muted};word-break:break-all">${escapeHtml(action.url)}</p>`
    ] : [],
    ...sections.flatMap((section) => [
      ...section.title ? [`<h2 style="margin:24px 0 8px;font-size:16px;line-height:1.3">${escapeHtml(section.title)}</h2>`] : [],
      ...section.rows?.length ? [`<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">${section.rows.map((row) => {
        const weight = row.strong ? ";font-weight:700" : "";
        return `<tr><td style="${cell};padding-right:16px${weight}">${escapeHtml(row.label)}</td><td style="${cell};text-align:right;white-space:nowrap${weight}">${escapeHtml(row.value)}</td></tr>`;
      }).join("")}</table>`] : [],
      ...section.lines?.length ? [`<p style="margin:0 0 16px">${section.lines.map(escapeHtml).join("<br>")}</p>`] : [],
      ...section.links.map((link) => `<p style="margin:0 0 8px"><a href="${escapeHtml(link.url)}" style="color:#1f2420">${escapeHtml(link.label)}</a></p>`)
    ]),
    ...(content.footer ?? []).map((line) => `<p style="margin:24px 0 0;${muted}">${escapeHtml(line)}</p>`),
    "</div></body></html>"
  ].join("\n");
  return { text, html };
}
var oneLine = (value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
function storeSections(store) {
  return [
    { title: "Seller", lines: [
      store.legalName ?? store.name,
      ...store.address,
      ...store.supportEmail ? [`Email: ${store.supportEmail}`] : []
    ] },
    { title: "Terms and your rights", links: [
      ...store.termsUrl ? [{ label: "Terms of sale", url: store.termsUrl }] : [],
      ...store.returnsUrl ? [{ label: "Returns and right of withdrawal", url: store.returnsUrl }] : [],
      ...store.warrantyUrl ? [{ label: "Warranty", url: store.warrantyUrl }] : []
    ] }
  ];
}
var contact = (store) => store.supportEmail ? `write to ${store.supportEmail}` : `contact ${store.name}`;
function orderConfirmationEmail({ store, order }) {
  const money = (cents) => formatMoney2(cents, order.currency);
  const shippingLines = formatAddress(order.shippingAddress);
  return {
    subject: oneLine(`Your ${store.name} order is confirmed`),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: "Thank you for your order",
      paragraphs: [
        `We have received your payment for order ${order.id}, placed on ${formatDate(order.placedAt)}.`,
        "This email confirms your order. Please keep it for your records."
      ],
      sections: [
        { title: "Items", rows: order.items.map((item) => ({ label: `${item.quantity} \xD7 ${item.name}`, value: money(item.lineCents) })) },
        { title: "Payment", rows: order.amounts.map((amount) => ({
          label: amount.label,
          value: money(amount.cents),
          strong: amount.key === "charged"
        })) },
        ...shippingLines.length ? [{ title: "Shipping to", lines: shippingLines }] : [],
        ...storeSections(store)
      ],
      footer: [`Questions about your order? Please ${contact(store)} and mention the order number.`]
    })
  };
}
function shipmentEmail({ store, order, shipment, update }) {
  const shippedOn = formatDate(shipment.shippedAt);
  const part = !shipment.completesOrder ? "part" : shipment.earlierShipments ? "rest" : "whole";
  const paragraphs = update ? [`The shipping details of a parcel of order ${order.id} have changed. They replace the ones we sent you before.`] : {
    whole: [`We shipped your order ${order.id} on ${shippedOn}.`],
    part: [`We shipped a parcel of your order ${order.id} on ${shippedOn}.`, "More parcels will follow."],
    rest: [`We shipped the last parcel of your order ${order.id} on ${shippedOn}.`]
  }[part];
  const rows = [
    ...shipment.carrier ? [{ label: "Carrier", value: shipment.carrier }] : [],
    ...shipment.trackingNumber ? [{ label: "Tracking number", value: shipment.trackingNumber }] : []
  ];
  if (!shipment.trackingNumber) paragraphs.push("This parcel has no tracking number.");
  return {
    subject: oneLine(update ? `Updated shipping details for your ${store.name} order` : {
      whole: `Your ${store.name} order has shipped`,
      part: `Part of your ${store.name} order has shipped`,
      rest: `The rest of your ${store.name} order has shipped`
    }[part]),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: update ? "Updated shipping details" : {
        whole: "Your order is on its way",
        part: "Part of your order is on its way",
        rest: "The rest of your order is on its way"
      }[part],
      paragraphs,
      sections: rows.length ? [{ title: "Shipment", rows }] : [],
      footer: [`Questions about your delivery? Please ${contact(store)} and mention the order number.`]
    })
  };
}
function giftCardClaimEmail({ store, purchase, claim }) {
  return {
    subject: oneLine(`Your ${store.name} gift card`),
    ...renderCommerceEmail({
      storeName: store.name,
      heading: "Your gift card is ready",
      paragraphs: [
        `Thank you for buying a ${formatMoney2(purchase.amountCents, purchase.currency)} gift card from ${store.name}. Use the link below to show its code. The link works once and expires on ${formatDate(claim.expiresAt)}.`,
        "Anyone who has the code can spend its balance, so share it only with the person you are giving it to."
      ],
      action: { label: "Show the gift card code", url: claim.url },
      footer: [`If the link has expired or was already used, please ${contact(store)} and ask for a new one.`]
    })
  };
}

export {
  shopperSignInEmail,
  formatMoney2 as formatMoney,
  formatDate,
  formatAddress,
  emailLink,
  renderCommerceEmail,
  orderConfirmationEmail,
  shipmentEmail,
  giftCardClaimEmail
};
