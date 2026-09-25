# Talisman Analytics

`@talisman-cms/plugin-analytics` adds a Cloudflare Web Analytics screen to Talisman CMS. When `@talisman-cms/plugin-ecommerce` is also registered, it adds a Commerce analytics screen using confirmed D1 orders. No analytics database migration is needed.

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

Supported questions cover confirmed sales, top products, refunds, traffic, and traffic alongside sales for today, yesterday, the last 7 or 30 days, this month, or last month. Precise conversion funnels, attribution, customer-level analysis, predictions, and causal explanations are not supported by these data sources. Reports show their date boundaries and metric definitions. If the AI binding is missing, the endpoint returns a configuration error.

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

Commerce reports confirmed purchases by payment date, separately for each currency. It excludes admin test and pending orders. Gross sales are item subtotals after discounts; net sales subtract known refunds, with fully refunded orders counted as zero. Gift-card and store-credit tender contribute to sales. Top-product sales and units exclude fully refunded orders but are **before discounts and partial refunds**, since those amounts cannot reliably be allocated to individual items. It never returns customer emails or addresses to the dashboard.

Cloudflare may use [adaptive sampling](https://developers.cloudflare.com/web-analytics/faq/) for aggregated traffic. Cloudflare page views and D1 orders have different collection methods, so the plugin does not claim a precise visit-to-purchase conversion rate. Cloudflare Web Analytics currently has no custom events or UTM attribution.
