# Talisman CMS playground

A local Astro site that runs Talisman CMS from this repository's source with every first-party plugin: ecommerce, Stripe sync, analytics, daisyUI and Starwind. Use it to develop the packages and as a worked example. It is not a production template: `wrangler.toml` uses placeholder D1 and KV IDs.

## Run it

From the repository root:

```sh
pnpm install
cp playground/.dev.vars.example playground/.dev.vars   # then fill in both values
pnpm --filter talisman-cms db:migrate:local             # applies packages/talisman-cms/drizzle to the local D1
pnpm dev                                                # astro dev for the playground
```

Open `http://localhost:4321/admin`, enter `TALISMAN_AUTH_SETUP_TOKEN` from `.dev.vars`, and create the first admin. `pnpm --filter talisman-cms db:seed:ecommerce:local` adds demo products.

## What to look at

| Path | Shows |
| --- | --- |
| `astro.config.mjs` | The integration with collections, globals, blocks and all plugins. |
| `src/pages/[slug].astro` | Page-builder blocks rendered with `talisman-cms/render/BlocksRenderer.astro`. |
| `src/pages/blog/[slug].astro` | Rich text rendered with `renderRichText` from `talisman-cms/richtext`. |
| `src/pages/shop`, `cart.astro`, `checkout.astro` | Storefront pages on `@talisman-cms/plugin-ecommerce`. Checkout stays off unless `TALISMAN_COMMERCE_CHECKOUT_ENABLED=true`. |
| `src/lib/commerce.ts` | Cart helpers; the basket token comes from the plugin's HttpOnly cookie helper. |
| `src/live.config.ts` | Live content collections through `talismanLiveLoader`. |

## Rendering CMS content safely

Editors control everything stored in the CMS. Render `richtext` fields with `renderRichText()`, which escapes all text, keeps only the editor's own markup and drops unsafe links. Never pass a stored value to `set:html` yourself. The config also enables Astro's `security.csp`, so a built site blocks injected inline scripts as a second line of defence (`astro dev` does not apply the policy). Keep it on in sites built from this example.
