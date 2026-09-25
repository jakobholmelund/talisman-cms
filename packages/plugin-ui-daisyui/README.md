# @talisman-cms/plugin-ui-daisyui

Manifest-first daisyUI library adapters for Talisman CMS.

## What It Adds

`daisyUiPlugin()` (plugin name `@talisman-cms/plugin-ui-daisyui`) registers the following. Paths use the default `adminPath` of `/admin`; the admin screen and endpoints move with a custom `adminPath`.

| Kind | Name or path | Who can use it |
| --- | --- | --- |
| UI library | `daisyui` ("daisyUI"): 64 component adapters and the blocks `daisyHeroBanner` and `daisyFeatureGrid`, listed under [Mapping](#mapping) | Editors pick them in `blocks` fields that list them in `blocksFromPlugins`, or in component slots |
| Global | `daisyui-theme` ("DaisyUI Theme Settings"): base light and dark theme names, colour overrides and radius, border and animation values | Any CMS user, in **Globals** or the Theme Builder |
| Admin screen | **DaisyUI Theme** (the Theme Builder) at `/admin/extensions/daisyui-theme` | Any CMS user |
| Endpoint | `GET /admin/api/daisyui/theme` returns the saved theme settings | Any CMS user; `401` without a session |
| Endpoint | `POST /admin/api/daisyui/theme` saves them. It takes a JSON body only and rejects values outside the allowlist below with `400` | Any CMS user; `401` without a session |
| Endpoint | `GET /admin/api/daisyui/layouts` lists the site's `src/layouts/*.astro` files for the preview | Any CMS user; `401` without a session |
| Page | `/admin/daisyui-preview` renders the saved theme inside one of those layouts, with `Cache-Control: private, no-store` and `noindex` | Any CMS user; others are redirected to the admin sign-in. The path stays `/admin/daisyui-preview` even with a custom `adminPath` |

Editors and admins can both change the theme, just as both can edit any global. The plugin adds no public route.

### Theme injector

The site applies the saved theme with `DaisyUiThemeInjector`. Put it in the `<head>` of each layout:

```astro
---
import DaisyUiThemeInjector from '@talisman-cms/plugin-ui-daisyui/components/DaisyUiThemeInjector.astro';
---
<head>
  <DaisyUiThemeInjector />
</head>
```

It reads the `daisyui-theme` global through the CMS client (the `DB` and optional `KV` bindings) on each render and outputs a `<style>` element with the theme's CSS variables, plus a short inline script that sets `data-theme` from the visitor's saved choice or the OS colour scheme.

The injector treats the stored theme as untrusted, because any CMS user can write the global through the Theme Builder or the core globals API. The endpoint validates values on save, and the injector validates them again on render. Theme names must match `[a-z0-9_-]`. Colours must be hex values, named colours, or `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` or `color()` with plain arguments. Radius, border, scale and animation values must be plain CSS numbers, optionally with a unit such as `px`, `rem` or `s`. Anything else is dropped, so a stored value cannot close the `<style>` element or inject other CSS. `buildThemeCss()` and `sanitizeThemeSettings()` are exported for sites that render the theme themselves.

### Other exports

- `daisyUiLibrary()`: the UI library definition without the global, admin screen and routes.
- `safeHref`, `cssUrl`, `safeCssLength`, `clampInteger`: the checks the renderers apply to block and component values.
- `@talisman-cms/plugin-ui-daisyui/generator`: manifest types and paths for the catalog scripts.
- Source paths for Astro and React: `renderers/*`, `components/*`, `admin/*` and `routes/*`.

## Setup

Install the plugin and make sure the site already has daisyUI available in its Tailwind pipeline.

```bash
pnpm add @talisman-cms/plugin-ui-daisyui
```

```ts
import talismanCms from 'talisman-cms';
import { daisyUiPlugin } from '@talisman-cms/plugin-ui-daisyui';

talismanCms({
  plugins: [daisyUiPlugin()],
});
```

The checked-in manifest tracks these requirements:

- Install `daisyui`
- Enable the daisyUI plugin in your Tailwind or Astro CSS pipeline
- Optionally configure a daisyUI theme

With the Tailwind v4 setup already used in this repo, that means:

```ts
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
```

```css
@import "tailwindcss";
@plugin "daisyui";
```

## Mapping

The canonical source of truth is [`catalog.manifest.json`](./catalog.manifest.json). `src/generated.ts` is derived from it.

- `accordion` -> `daisyAccordionList`
- `button` -> `daisyButtonAction`
- `alert` -> `daisyAlertNotice`
- `avatar` -> `daisyAvatarProfile`
- `badge` -> `daisyBadgePill`
- `breadcrumbs` -> `daisyBreadcrumbTrail`
- `calendar` -> `daisyCalendarCard`
- `card` -> `daisyFeatureCard`
- `chat-bubble` -> `daisyChatBubble`
- `collapse` -> `daisyCollapsePanel`
- `countdown` -> `daisyCountdownTimer`
- `diff` -> `daisyDiffCompare`
- `divider` -> `daisyDividerRule`
- `drawer` -> `daisyDrawerShell`
- `dropdown` -> `daisyDropdownMenu`
- `hero` -> `daisyHeroBanner`
- `indicator` -> `daisyIndicatorBadge`
- `join` -> `daisyJoinGroup`
- `kbd` -> `daisyKeycap`
- `link` -> `daisyTextLink`
- `list` -> `daisyItemList`
- `loading` -> `daisyLoadingIndicator`
- `mask` -> `daisyMaskFrame`
- `menu` -> `daisyMenuList`
- `mockup-browser` -> `daisyMockupBrowser`
- `mockup-code` -> `daisyMockupCode`
- `mockup-phone` -> `daisyMockupPhone`
- `mockup-window` -> `daisyMockupWindow`
- `modal` -> `daisyModalDialog`
- `navbar` -> `daisyNavbarBar`
- `pagination` -> `daisyPaginationNav`
- `progress` -> `daisyProgressBar`
- `rating` -> `daisyRatingStars`
- `skeleton` -> `daisySkeletonBlock`
- `stack` -> `daisyStackDeck`
- `stat` -> `daisyStatCard`
- `status` -> `daisyStatusDot`
- `steps` -> `daisyStepsList`
- `swap` -> `daisySwapToggle`
- `table` -> `daisyDataTable`
- `tabs` -> `daisyTabsNav`
- `text-rotate` -> `daisyTextRotate`
- `theme-controller` -> `daisyThemeController`
- `timeline` -> `daisyTimelineTrack`
- `toast` -> `daisyToastStack`
- `tooltip` -> `daisyTooltipHint`
- `carousel` -> `daisyCarouselStrip`
- `checkbox` -> `daisyCheckboxField`
- `dock` -> `daisyDockNav`
- `fab` -> `daisyFabButton`
- `fieldset` -> `daisyFieldsetGroup`
- `file-input` -> `daisyFileInputField`
- `filter` -> `daisyFilterChips`
- `footer` -> `daisyFooterLinks`
- `hover-3d-card` -> `daisyHoverTiltCard`
- `hover-gallery` -> `daisyHoverGallery`
- `input` -> `daisyTextInput`
- `label` -> `daisyFieldLabel`
- `radial-progress` -> `daisyRadialProgress`
- `radio` -> `daisyRadioGroup`
- `range` -> `daisyRangeSlider`
- `select` -> `daisySelectField`
- `textarea` -> `daisyTextareaField`
- `toggle` -> `daisyToggleSwitch`
- `validator` -> `daisyValidatorMessage`
- `grid` -> `daisyFeatureGrid` as a Talisman-only composed block

## Coverage

Coverage is audited against [`catalog.upstream.json`](./catalog.upstream.json).

- Total upstream items: 65
- Complete: 65
- Partial: 0
- Unsupported: 0
- Custom Talisman items: 1

`complete` means the manifest entry is classified, has adapter metadata, and has a renderer mapping.

## Known Limitations

- All upstream daisyUI items in the checked-in catalog are now mapped and classified as `complete`.
- `daisyFeatureGrid` is a Talisman composition, not a direct upstream daisyUI catalog item.
- Some highly interactive or form-heavy daisyUI patterns are represented as pragmatic Talisman-friendly previews rather than full behavior clones.
- The plugin does not fetch upstream docs at runtime; refreshes happen through the import workflow.

## Commands

```bash
pnpm run import-catalog
pnpm run generate
pnpm run coverage
pnpm run coverage:json
pnpm run test
```

`import-catalog` merges the checked-in upstream snapshot into the manifest while preserving handwritten adapter metadata. `generate` rewrites `src/generated.ts` and creates missing renderer stubs for supported entries. `coverage` is the CI gate.
