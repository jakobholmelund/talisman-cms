# @talisman-cms/plugin-ui-daisyui

Manifest-first daisyUI library adapters for Talisman CMS.

## What It Adds

`daisyUiPlugin()` (plugin name `@talisman-cms/plugin-ui-daisyui`) registers the following. Paths use the default `adminPath` of `/admin`; the admin screen and endpoints move with a custom `adminPath`.

| Kind | Name or path | Who can use it |
| --- | --- | --- |
| UI library | `daisyui` ("daisyUI"): 64 component adapters and the blocks `daisyHeroBanner` and `daisyFeatureGrid`, listed under [Mapping](#mapping) | Editors pick them in `blocks` fields that list them in `blocksFromPlugins`, or in component slots |
| Global | `daisyui-theme` ("DaisyUI Theme Settings"): base light and dark theme names, plus colour, radius, size, border and effect overrides | Any CMS user, in **Globals** or the Theme Builder |
| Admin screen | **DaisyUI Theme** (the Theme Builder) at `/admin/extensions/daisyui-theme` | Any CMS user |
| Endpoint | `GET /admin/api/daisyui/theme` returns the saved theme settings and concurrency `version` | Any CMS user; `401` without a session |
| Endpoint | `POST /admin/api/daisyui/theme` saves them with the GET response’s `version` supplied as `expectedVersion`; stale saves return `409`, missing/invalid versions return `400`. It takes a JSON body only and rejects values outside the allowlist below with `400` | Any CMS user; `401` without a session |
| Endpoint | `GET /admin/api/daisyui/layouts` lists the site's `src/layouts/*.astro` files for the preview | Any CMS user; `401` without a session |
| Page | `/admin/daisyui-preview` renders the saved theme inside one of those layouts, with `Cache-Control: private, no-store` and `noindex` | Any CMS user; others are redirected to the admin sign-in. The preview path follows a custom `adminPath` too |

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

It reads the `daisyui-theme` global through the CMS client (the `DB` and optional `KV` bindings) on each render and outputs sanitized theme metadata and an external script that applies the saved overrides with a constructed stylesheet that sets `data-theme` from the visitor's saved choice or the OS colour scheme. The saved theme only affects layouts that render the injector.

The injector treats the stored theme as untrusted, because any CMS user can write the global through the Theme Builder or the core globals API. The endpoint validates values on save, and the injector validates them again on render. Theme names must match `[a-z0-9_-]`. Colours must be hex values, named colours, or `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` or `color()` with plain arguments. Radius, size, border, depth and noise values must be plain CSS numbers, optionally with a unit such as `px` or `rem`. Anything else is dropped, so a stored value cannot close the `<style>` element or inject other CSS. `buildThemeCss()` and `sanitizeThemeSettings()` are exported for sites that render the theme themselves.

### Theme Builder

The Theme Builder starts from two daisyUI themes, one for light mode and one for dark mode, and stores only the values you change on top of them. An empty field shows the base theme's own value in grey and is not saved, so saving without edits leaves both daisyUI themes as they are. **Reset** clears one override, and **Reset all** clears a mode's colours. Picking another base theme clears that mode's colour overrides, after a confirmation. **Open Full Preview** shows the unsaved values in place of the saved overrides. Leaving with unsaved edits prompts before navigation or closing the tab. Save errors keep your edits. After a conflict, **Load latest version (keep my edits)** shows the newer saved state; **Reapply my changes** overlays only the values you changed, preserving unrelated newer settings. Review overlapping changes before saving; your edits win those overlaps.

- Colours are the 20 daisyUI 5 colour tokens (`--color-primary`, `--color-base-100`, ...). Type any allowed colour, such as `#ff0000` or `oklch(58% 0.233 277.117)`, or use the colour picker.
- Advanced values are daisyUI 5's `--radius-box`, `--radius-field`, `--radius-selector`, `--size-field`, `--size-selector`, `--border`, `--depth` and `--noise`. They apply to both base themes.
- The site's daisyUI build must include both base themes, for example `@plugin "daisyui" { themes: light --default, dark --prefersdark; }`. The builder lists daisyUI's built-in themes; a theme saved under another name is kept and shown as not built in.
- The injector writes the overrides into `[data-theme="<theme>"][data-theme]` rules, which beat daisyUI's own theme rules whether daisyUI comes from Tailwind's `@layer base` or from its standalone `themes.css`.
- Advanced keys saved by earlier versions (`rounded-btn`, `animation-btn`, `tab-radius` and the like) name daisyUI 4 variables and are ignored. Colour overrides saved by earlier versions stay; clear them with **Reset all** if dark mode shows light colours.

The base-theme values the builder shows are generated from daisyUI's own theme data into `src/admin/themeDefaults.ts`. After deliberately upgrading the pinned daisyUI development dependency, run `pnpm run theme-defaults`; the test suite fails while the file is out of date.

### Content Security Policy

The injector uses an external script and a constructed stylesheet under Astro’s `security.csp`. Full Preview applies sanitized unsaved CSS through a constructed stylesheet and uses a bundled refresh handler, so it does not require inline script/style elements or event handlers. Constructed stylesheets require a modern browser. Host layouts must include the CSS source above. A host’s separate stricter CSP headers still need to permit its bundled scripts and CSS; the Theme Builder’s React preview uses style properties.

### Other exports

- `daisyUiLibrary()`: the UI library definition without the global, admin screen and routes.
- `safeHref`, `cssUrl`, `safeCssLength`, `clampInteger`: the checks the renderers apply to block and component values.
- `DAISYUI_THEME_DEFAULTS` and `DAISYUI_THEME_DEFAULTS_VERSION`: the colours and variables of daisyUI's built-in themes, as the Theme Builder shows them.
- `createThemeEditorState`, `themeEditorPayload`, `reapplyThemeChanges`, `themeDefaultValue`, `colorToHex`: the Theme Builder's state helpers.
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
/* In src/styles/global.css, include plugin source (dependencies are excluded from auto-scanning). */
@source "../../node_modules/@talisman-cms/plugin-ui-daisyui/src";
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
- Complete: 38
- Partial: 27
- Unsupported: 0
- Custom Talisman items: 1

`complete` means the adapter renders its declared content and behavior. `partial` marks static previews, form controls requiring host submission/persistence, and patterns missing full interaction or accessibility behavior; each entry states its limitation in the manifest. Mapped renderers must exist inside the package and must not be generated stubs.

## Known Limitations

- All upstream daisyUI items are mapped; 27 are explicitly classified as partial.
- `daisyFeatureGrid` is a Talisman composition, not a direct upstream daisyUI catalog item.
- Some highly interactive or form-heavy daisyUI patterns are represented as pragmatic Talisman-friendly previews rather than full behavior clones.
- The plugin does not fetch upstream docs at runtime; refreshes happen through the import workflow.

## Commands

```bash
pnpm run import-catalog
pnpm run generate
pnpm run coverage
pnpm run coverage:json
pnpm run theme-defaults
pnpm run test
pnpm run test:browser # local Chrome, or set TALISMAN_CHROME_PATH
```

`import-catalog` merges the checked-in upstream snapshot into the manifest while preserving handwritten adapter metadata. `generate` rewrites `src/generated.ts` and refuses missing or stub mapped renderers. `coverage` is the CI gate. `theme-defaults` regenerates `src/admin/themeDefaults.ts` from the package’s pinned daisyUI development dependency (5.7.42) (`--check` only compares).

For the built preview regression, start a sanitized playground with a throwaway local database and auth secret, add a `src/layouts/DaisyPreview.astro` layout that imports the site CSS and renders its default slot, then run `TALISMAN_DAISYUI_PREVIEW_URL=http://127.0.0.1:8787 TALISMAN_DAISYUI_ADMIN_PATH=/admin TALISMAN_E2E_SETUP_TOKEN=<throwaway-token> node --test test/preview.browser.mjs`. It creates `daisy-preview@example.test` only during first-admin setup, and checks authentication, saved and unsaved theme styles, CSS scanning, and CSP. Run it only against the throwaway local playground.
