# Talisman Analytics

`@talisman-cms/plugin-analytics` adds a Cloudflare Web Analytics screen to Talisman CMS. When `@talisman-cms/plugin-ecommerce` is also registered, it adds a Commerce analytics screen using confirmed D1 orders. No analytics database migration is needed; the Commerce reports read the ecommerce order tables, including the shipping and tax columns that the CMS migration `0025_order_shipping_and_tax.sql` adds, so apply the CMS migrations first.

```ts
import { analyticsPlugin } from '@talisman-cms/plugin-analytics';
import { ecommercePlugin } from '@talisman-cms/plugin-ecommerce';

talismanCms({
  plugins: [analyticsPlugin(), ecommercePlugin()]
})
```

The screens appear under **Extensions**. The Commerce screen is shown only when the ecommerce plugin is registered; pass `analyticsPlugin({ commerce: false })` to hide it. Traffic is available to authenticated CMS users. Commerce metrics require the CMS admin role.

## Ask Analytics

To add a plain-English report screen alongside Commerce analytics, enable it explicitly and bind [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/configuration/bindings/) to the Worker:

```ts
analyticsPlugin({ ask: true })
```

```toml
[ai]
binding = "AI"
```

The screen and its POST endpoint are available only when the ecommerce plugin is registered. Questions require the CMS admin role. A Workers AI model maps each question to an allowlisted subject, UTC period, and optional previous-period comparison. Talisman then calculates the report from D1 and/or Cloudflare; the model cannot run SQL or see order, customer, or traffic records. Questions are sent to Workers AI and [inference uses the account's Workers AI allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Supported questions cover confirmed sales, top products, refunds, traffic, and traffic alongside sales for today, yesterday, the last 7 or 30 days, this month, or last month. Precise conversion funnels, attribution, customer-level analysis, predictions, and causal explanations are not supported by these data sources. Reports show their exact UTC boundaries, with times whenever a boundary is not at midnight, and their metric definitions. If the AI binding is missing, the endpoint returns a configuration error.

Comparisons use the matching span of the period before. Today is compared with yesterday up to the same time. This month is compared with last month up to the same day and time, or with all of last month once this month is longer. Yesterday is compared with the day before, last month with the month before, and the last 7 or 30 days with the 7 or 30 days before them. The summary names the exact window it compares with. A refunds question is summarized and compared by refunds, not by net sales. Until refund dates are recorded (see below), a refunds comparison compares the refunds on the orders paid in each window, not the refunds issued in it, and the summary and metrics say so.

## Cloudflare setup

Enable [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/) for your site. Configure these **Worker bindings** (not `astro.config`, CMS globals, or client environment variables):

| Binding | Value |
| --- | --- |
| `CLOUDFLARE_ANALYTICS_ACCOUNT_ID` | 32-character Cloudflare account ID |
| `CLOUDFLARE_ANALYTICS_SITE_TAG` | 32-character token from the Web Analytics beacon snippet |
| `CLOUDFLARE_ANALYTICS_API_TOKEN` | API token scoped to this account with **Account Analytics: Read** |

Create the token using [Cloudflare's Analytics API token guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/). For a deployed Worker, store the API token as a secret. The account ID and site tag may be plain text Worker variables.

If Cloudflare already injects its beacon, no Astro changes are needed. For a site without automatic injection, add the optional component once in the public page layout:

```astro
---
import Beacon from '@talisman-cms/plugin-analytics/beacon';
---
<head>
  <Beacon token="YOUR_WEB_ANALYTICS_SITE_TAG" />
</head>
```

The beacon token is public. If the site uses a Content Security Policy, allow the [Cloudflare beacon script and reporting endpoint](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp). Do not add the component when Cloudflare is already injecting the beacon, or page views may be counted twice.

## What the screens show

Traffic reports Cloudflare page views, visits, top paths, referrers, countries, and p75 Core Web Vitals for 7 or 30 days. A top path links to its Talisman **Pages** editor when it exactly matches a published `/<page-slug>` route. Sites with custom route shapes can still use the traffic report; these links are intentionally limited to paths Talisman can match confidently. Core Web Vitals may be unavailable for a site or API plan while the traffic report remains usable.

Commerce reports confirmed purchases by payment date, separately for each currency, with UTC dates. It excludes pending orders and admin test orders. When the store is in live mode (`TALISMAN_COMMERCE_STRIPE_MODE=live`), it also excludes Stripe test-mode orders: orders whose Stripe Checkout Session id starts with `cs_test_`, and gift-card-only orders paid with a gift card bought in test mode. In test mode, which plugin-ecommerce uses unless that setting is `live`, those orders are included so local and staging checkouts show up, and the Commerce toolbar and the Ask Analytics report notes say so. Gross sales are the items after discounts, without the shipping and tax added to the price; tax included in the prices stays in sales. The average order is gross sales per order. Gift-card and store-credit tender contribute to sales. Top-product sales and units exclude fully refunded orders but are **before discounts and partial refunds**, since those amounts cannot reliably be allocated to individual items. The Commerce API's `charged` figure is what the payment providers charged, shipping and tax included. It never returns customer emails or addresses to the dashboard.

Amounts are integers in each currency's minor units, as `Intl.NumberFormat` defines them, and the screens and Ask Analytics format them that way: two decimals for USD, none for JPY and three for KWD. The daily chart's tooltips show net sales in their currency.

A refund does not record whether it returned items, shipping or tax, so only the items' share of it counts against sales. With gross being the order's items after discounts, that share is the refund × gross ÷ (gross + shipping + exclusive tax), rounded half up and never more than the gross. A full refund counts the whole gross. Orders without shipping or exclusive tax, including every order placed before migration `0025`, count their refunds in full, up to the gross, as before. An order counts as refunded only when the items' share of its refunds is above 0. The Commerce screen's footnote and the Ask Analytics report notes state this rule.

How refunds are dated depends on the database, and both screens say which rule applies:

- **By refund date.** When the database has a `_ecommerce_provider_refunds` table (one row per payment-provider refund, with its amount and the time it was issued), each refund counts on the date it was issued, as in Stripe. Net sales are gross sales less the refunds issued in the same period, so a past period no longer changes when one of its orders is refunded later, and a day with more refunds than sales shows negative net sales. An order's provider refunds never count for more than its recorded provider refund total; if its rows add up to more, the latest are trimmed. Gift-card refunds use their own dates. Each dated refund counts for the items' share of the order's refunds up to and including it, less the share of those before it, so the parts add up to the order's share without a rounding remainder. Store credit and gift-card balance returned by a full refund count when the order was fully refunded. Refunds recorded before refund dates were stored count on the payment date, and the report notes it.
- **By payment date.** Without that table, the plugin cannot tell when a Stripe refund was issued. Every refund counts on the payment date of the refunded order, and net sales are those orders' sales less their refunds so far, so the totals for a past period drop when one of its orders is refunded later.

Cloudflare may use [adaptive sampling](https://developers.cloudflare.com/web-analytics/faq/) for aggregated traffic. Cloudflare page views and D1 orders have different collection methods, so the plugin does not claim a precise visit-to-purchase conversion rate. Cloudflare Web Analytics currently has no custom events or UTM attribution.
