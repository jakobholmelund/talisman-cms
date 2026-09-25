# 🌌 Talisman CMS

**An Astro headless CMS built for Cloudflare Workers and Pages.** Content lives in your D1 database, with optional R2 media and KV caching.

Talisman CMS is under active development. Public checkout remains disabled by default; use the package and commerce readiness notes before deploying a site.

Talisman CMS and its plugins are licensed under [Apache-2.0](LICENSE.md).

---

## ✨ Key Features

### 🚀 Deep Astro Native Integration
Talisman CMS integrates directly with Astro. Configure the backend in your `astro.config.mjs` and use Vite HMR, custom server hooks, and an optimized server-rendering pipeline that just works out of the box with the Astro ecosystem.

### 🛠️ Talisman CMS Dev Toolbar App
Astro 7's Dev Toolbar is extended natively by Talisman CMS during development:
- **1-Click Admin Launch**: Jump straight into `/admin` or the Pages collection without memorizing endpoints.
- **Route Context**: See the path of the page you're viewing next to the admin shortcuts.
- **Layout Block Inspector**: Outline every rendered block marked with `data-talisman-block` and label it with its block type and position.

### 🏝️ Server Islands (`server:defer`)
Personalized commerce and marketing storefronts without holding up the page. Wrap personalized dynamic components (such as the ecommerce plugin's `<CartBadge server:defer>`) in Server Islands with fallback skeletons. The page shell renders without waiting for them, so it can be cached separately, while user sessions and cart items load asynchronously.

### 📦 Astro Content Loaders
For Cloudflare data at request time, define live collections:
```typescript
// src/live.config.ts
import { defineLiveCollection } from 'astro:content';
import { talismanLiveLoader } from 'talisman-cms/loader';

export const collections = {
  posts: defineLiveCollection({ loader: talismanLiveLoader({ collection: 'posts' }) }),
  pages: defineLiveCollection({ loader: talismanLiveLoader({ collection: 'pages' }) }),
};
```
Use `getLiveCollection()` in server-rendered pages. For `defineCollection()` and `getCollection()` during Astro builds, use `talismanLoader({ collection, buildEntries })` and supply entries from a data source available to the build process. The loader fails if `buildEntries` is missing or fails, so builds cannot silently publish empty content.

### ⚡ Type-Safe Server Actions (`astro:actions`)
E-commerce interactions (`addToCart`, `getCart`, `clearCart`, `checkout`) are exposed as type-safe Astro actions via `@talisman-cms/plugin-ecommerce/actions`. Eliminate manual `fetch()` endpoints and enjoy end-to-end type safety, Zod input validation, and automatic CSRF protection.

### 📝 Next-Gen Drizzle Native Schemas
Native Schema Mapping lets you attach Drizzle ORM tables to the CMS UI while retaining control of your schema and migrations. The current runtime targets Cloudflare D1.

### 🧩 Polymorphic Layouts & Complex Fields
Talisman provides a comprehensive set of highly customizable fields designed for demanding modern marketing and editorial pages:
- **Core Types**: `text`, `textarea`, `number`, `boolean`, `date`
- **Relationships**: Create 1:1 and 1:N relations across internal collections and mapped Drizzle tables.
- **Rich Text**: Fully customizable WYSIWYG editing powered by robust **Tiptap** integrations.
- **Repeater Arrays**: Build flexible, repeatable list structures (`array` fields).
- **Polymorphic Blocks**: Create dynamic page layouts by composing arbitrary `blocks` like Hero Sections, Feature Grids, Testimonials, and plugin-provided blocks. Block fields can also attach shared presentation settings such as `className`, theme hooks, or UI-kit specific variants.

### ⚡ React 19 + TanStack Admin Panel
The admin dashboard is a blazing fast, intuitively designed React Single Page Application injected directly into your project. Utilizing `@tanstack/react-form` and exhaustive Zod type validation, the editing experience is buttery-smooth, type-safe, and incredibly reliable.

### 🔌 Extensible Plugin Architecture
Go beyond content. Talisman features a robust plugin ecosystem allowing you to bundle custom routes, schemas, and backend logic.
* **E-commerce Plugin (`@talisman-cms/plugin-ecommerce`)**: First-class e-commerce capabilities featuring dynamic automated Cart APIs, Product Management, Order tracking, inventory logic, and seamless Stripe Integration—all manageable directly from the CMS.

Checkout routes and actions are disabled by default. Enabling them requires `TALISMAN_COMMERCE_CHECKOUT_ENABLED=true` in the Worker environment and a working payment provider. Inventory reservations use D1 transactions, but live payment and store operations still need end-to-end verification before accepting orders. See the [commerce readiness review](packages/plugin-ecommerce/PRODUCTION_READINESS.md).

### 🔐 Local CMS accounts and auth adapters
Talisman supports local email/password accounts on D1 with admin/editor roles, plus optional Cloudflare Access verification. `HybridAuthAdapter` combines local editor passwords with Cloudflare Access SSO for admins at `/admin/sso`. Talisman also accepts custom runtime auth adapters. Private APIs fail closed without one. `DevAuthAdapter` grants access only on local hosts. The local adapter needs `TALISMAN_AUTH_SECRET` and a one-time `TALISMAN_AUTH_SETUP_TOKEN`; see the [authentication setup](packages/talisman-cms/README.md).

Collection hooks must be exported by a server module and registered through `runtimeHooks`; inline functions in `astro.config` cannot survive the server build. Stripe's sync plugin registers its runtime hooks automatically.

### 🌐 Cloudflare Edge Native
Talisman targets Cloudflare Workers, Pages, and D1. The playground build checks this integration; each deployed site still needs its own migration rehearsal, binding configuration, and runtime verification.

---

## 🛠️ Typical Configuration Example
Talisman CMS is uniquely configured directly within your Astro initialization:

```typescript
import { defineConfig } from 'astro/config';
import talismanCms from 'talisman-cms';
import { LocalAuthAdapter } from 'talisman-cms/auth/local';
import { createCollectionRepeaterBlock, getCollectionRepeaterViewModel } from 'talisman-cms/helpers';
import { ecommercePlugin } from '@talisman-cms/plugin-ecommerce';

export default defineConfig({
  output: 'server',
  integrations: [
    talismanCms({
      auth: LocalAuthAdapter(),
      plugins: [
        ecommercePlugin()
      ],
      collections: [
        {
          name: 'Pages',
          slug: 'pages',
          fields: [
            { name: 'title', label: 'Page Title', type: 'text', required: true },
            { 
              name: 'layout', 
              label: 'Page Layout', 
              type: 'blocks', // Polymorphic Blocks
              blocksFromPlugins: ['ecommerceFeaturedProducts'],
              blockSettings: {
                label: 'Presentation',
                fields: [
                  { name: 'className', label: 'Section Classes', type: 'text' },
                  { name: 'dataTheme', label: 'Data Theme', type: 'text' }
                ]
              },
              blocks: [
                {
                  name: 'Hero Section',
                  slug: 'hero',
                  description: 'High-impact landing section',
                  fields: [
                    { name: 'heading', label: 'Heading', type: 'text' },
                    { name: 'backgroundImage', label: 'Image URL', type: 'text' }
                  ]
                },
                createCollectionRepeaterBlock({
                  slug: 'featuredPosts',
                  name: 'Featured Posts',
                  relationTo: 'posts',
                  itemLabel: 'Posts',
                  ctaLabelDefault: 'View blog',
                  ctaHrefDefault: '/blog'
                })
              ]
            }
          ]
        }
      ]
    })
  ]
});
```

This repeater helper follows the same practical pattern used in systems like Payload: keep reusable content in its own collection, then reference those documents from a layout block via a relationship field. If you need a polymorphic picker, `relationTo` can also be an array like `['posts', 'products']`, and `getCollectionRepeaterViewModel(block)` will normalize the block payload for rendering.

---

*Open source under Apache-2.0.* 🚀
