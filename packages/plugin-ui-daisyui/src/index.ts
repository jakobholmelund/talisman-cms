import { fileURLToPath } from 'node:url';
import { daisyUiPlugin as basePlugin } from './generated';
import type { Plugin, GlobalConfig } from 'talisman-cms';
import { DAISYUI_THEME_ADVANCED, DAISYUI_THEME_COLORS } from './components/theme-css';

export { daisyUiLibrary } from './generated';
export { safeHref, cssUrl, safeCssLength, clampInteger } from './renderers/sanitize';
export { buildThemeCss, sanitizeThemeSettings, type DaisyUiThemeSettings } from './components/theme-css';
export { DAISYUI_THEME_DEFAULTS, DAISYUI_THEME_DEFAULTS_VERSION, type DaisyUiThemeDefaults } from './admin/themeDefaults';
export {
  colorToHex,
  createThemeEditorState,
  themeDefaultValue,
  themeEditorPayload,
  type ThemeEditorState,
} from './admin/theme-editor';

// Inject routes by file path, as the other plugins do. Vite's SSR dep optimizer treats a bare
// package specifier as a dependency, finds it after `astro dev` has started, and the reload
// that follows crashes a cold dev server. From dist/ and src/ alike this resolves to src/routes.
function routeEntrypoint(file: string) {
  return fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url));
}

// The global holds overrides only, the same keys the Theme Builder edits. An empty field keeps the
// base theme's value, so no field has a default.
const colorFields = () => DAISYUI_THEME_COLORS.map(({ key, label }) => ({ name: key, label, type: 'color' as const }));
const advancedFields = () => DAISYUI_THEME_ADVANCED.map(({ key, label }) => ({ name: key, label, type: 'text' as const }));

export function daisyUiPlugin(): Plugin {
  const base = basePlugin();
  
  return {
    ...base,
    onInit: (config) => {
      // Allow base plugin to initialize if needed
      const updatedConfig = base.onInit?.(config) ?? config;

      // Inject the hidden daisyui-theme global document config
      const themeGlobal: GlobalConfig = {
        name: 'DaisyUI Theme Settings',
        slug: 'daisyui-theme',
        description: 'Internal storage for DaisyUI visual theme builder colors',
        fields: [
          { name: 'lightTheme', label: 'Base Light Theme', type: 'text', defaultValue: 'light' },
          { name: 'darkTheme', label: 'Base Dark Theme', type: 'text', defaultValue: 'dark' },
          { name: 'lightColors', label: 'Light Mode Overrides', type: 'group', fields: colorFields() },
          { name: 'darkColors', label: 'Dark Mode Overrides', type: 'group', fields: colorFields() },
          { name: 'advanced', label: 'Radius, Size and Effect Overrides', type: 'group', fields: advancedFields() }
        ]
      };

      updatedConfig.globals = [...(updatedConfig.globals || []), themeGlobal];
      
      return updatedConfig;
    },
    adminUi: [
      {
        path: 'daisyui-theme',
        label: 'DaisyUI Theme',
        componentPath: '@talisman-cms/plugin-ui-daisyui/admin/ThemeBuilder'
      }
    ],
    // Relative to the admin path: the integration mounts it at `<adminPath>/daisyui-preview`.
    routes: [
      {
        path: 'daisyui-preview',
        entrypoint: routeEntrypoint('preview.astro'),
        prerender: false
      }
    ],
    endpoints: [
      {
        path: '/daisyui/theme',
        entrypoint: routeEntrypoint('api-theme.ts')
      },
      {
        path: '/daisyui/layouts',
        entrypoint: routeEntrypoint('api-layouts.ts')
      }
    ]
  };
}
