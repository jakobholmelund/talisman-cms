import {
  daisyUiLibrary,
  daisyUiPlugin
} from "./chunk-KXZTZRFF.js";

// src/index.ts
import { fileURLToPath } from "url";

// src/renderers/sanitize.ts
var SAFE_URL_SCHEMES = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
var CSS_LENGTH = /^(?:0|(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex)|auto)$/i;
function safeHref(value, fallback = "#") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\u0000- \u007f-\u009f]/g, ""));
  if (!scheme) return trimmed;
  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase()) ? trimmed : fallback;
}
function cssUrl(value) {
  const href = safeHref(value, "");
  if (!href) return "";
  const escaped = href.replace(/[\\"'()<>\u0000-\u001f\u007f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
  return `url("${escaped}")`;
}
function safeCssLength(value, fallback) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return CSS_LENGTH.test(text) ? text : fallback;
}
function clampInteger(value, min, max, fallback) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

// src/components/theme-css.ts
var DAISYUI_THEME_COLOR_KEYS = [
  "primary",
  "primary-content",
  "secondary",
  "secondary-content",
  "accent",
  "accent-content",
  "neutral",
  "neutral-content",
  "base-100",
  "base-200",
  "base-300",
  "base-content",
  "info",
  "info-content",
  "success",
  "success-content",
  "warning",
  "warning-content",
  "error",
  "error-content"
];
var DAISYUI_THEME_ADVANCED_VARS = {
  "rounded-box": "--radius-box",
  "rounded-btn": "--radius-field",
  "rounded-badge": "--radius-selector",
  "animation-btn": "--animation-btn",
  "animation-input": "--animation-input",
  "btn-focus-scale": "--btn-focus-scale",
  "border-btn": "--border",
  "tab-border": "--tab-border",
  "tab-radius": "--tab-radius"
};
var MAX_VALUE_LENGTH = 100;
var THEME_NAME = /^[a-z0-9_-]{1,64}$/i;
var HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
var FUNCTION_COLOR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9.%+\-\/,\s]*\)$/i;
var NAMED_COLOR = /^[a-z]{3,32}$/i;
var CSS_NUMBER = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|s|ms|vh|vw|ch|ex)?$/i;
function toValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= MAX_VALUE_LENGTH ? trimmed : null;
}
function isSafeThemeName(value) {
  return typeof value === "string" && THEME_NAME.test(value);
}
function isSafeThemeColor(value) {
  const text = toValue(value);
  return !!text && (HEX_COLOR.test(text) || FUNCTION_COLOR.test(text) || NAMED_COLOR.test(text));
}
function isSafeThemeNumber(value) {
  const text = toValue(value);
  return !!text && CSS_NUMBER.test(text);
}
function isEmpty(value) {
  return value === void 0 || value === null || typeof value === "string" && value.trim() === "";
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function sanitizeGroup(input, path, isAllowedKey, isSafe, rejected) {
  if (input === void 0 || input === null) return void 0;
  if (!isRecord(input)) {
    rejected.push(path);
    return void 0;
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (isEmpty(value)) continue;
    if (isAllowedKey(key) && isSafe(value)) output[key] = toValue(value);
    else rejected.push(`${path}.${key}`);
  }
  return output;
}
function sanitizeThemeSettings(input) {
  const rejected = [];
  const settings = {};
  if (!isRecord(input)) return { settings, rejected: isEmpty(input) ? rejected : ["(root)"] };
  const isColorKey = (key) => DAISYUI_THEME_COLOR_KEYS.includes(key);
  const isAdvancedKey = (key) => Object.prototype.hasOwnProperty.call(DAISYUI_THEME_ADVANCED_VARS, key);
  for (const [key, value] of Object.entries(input)) {
    if (key === "lightTheme" || key === "darkTheme") {
      if (isEmpty(value)) continue;
      if (isSafeThemeName(value)) settings[key] = value;
      else rejected.push(key);
    } else if (key === "lightColors" || key === "darkColors") {
      const colors = sanitizeGroup(value, key, isColorKey, isSafeThemeColor, rejected);
      if (colors) settings[key] = colors;
    } else if (key === "advanced") {
      const advanced = sanitizeGroup(value, key, isAdvancedKey, isSafeThemeNumber, rejected);
      if (advanced) settings.advanced = advanced;
    } else {
      rejected.push(key);
    }
  }
  return { settings, rejected };
}
function buildThemeCss(input) {
  const { settings } = sanitizeThemeSettings(input);
  const lightTheme = settings.lightTheme || "light";
  const darkTheme = settings.darkTheme || "dark";
  const colorVars = (colors = {}) => Object.entries(colors).map(([key, value]) => `--color-${key}: ${value};`).join(" ");
  const advanced = settings.advanced || {};
  const advancedVars = Object.keys(advanced).map((key) => `${DAISYUI_THEME_ADVANCED_VARS[key]}: ${advanced[key]};`).join(" ");
  const css = `
  :root { ${advancedVars} }
  [data-theme="${lightTheme}"] { ${colorVars(settings.lightColors)} }
  [data-theme="${darkTheme}"] { ${colorVars(settings.darkColors)} }
`;
  return { css: css.replace(/</g, "\\3c "), lightTheme, darkTheme };
}

// src/index.ts
function routeEntrypoint(file) {
  return fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url));
}
function daisyUiPlugin2() {
  const base = daisyUiPlugin();
  return {
    ...base,
    onInit: (config) => {
      let updatedConfig = base.onInit ? base.onInit(config) : config;
      const themeGlobal = {
        name: "DaisyUI Theme Settings",
        slug: "daisyui-theme",
        description: "Internal storage for DaisyUI visual theme builder colors",
        fields: [
          { name: "lightTheme", label: "Base Light Theme", type: "text", defaultValue: "light" },
          { name: "darkTheme", label: "Base Dark Theme", type: "text", defaultValue: "dark" },
          { name: "lightColors", label: "Light Mode Overrides", type: "group", fields: [
            { name: "primary", label: "Primary", type: "color" },
            { name: "secondary", label: "Secondary", type: "color" },
            { name: "accent", label: "Accent", type: "color" },
            { name: "neutral", label: "Neutral", type: "color" },
            { name: "base-100", label: "Base 100", type: "color" },
            { name: "base-200", label: "Base 200", type: "color" },
            { name: "base-300", label: "Base 300", type: "color" },
            { name: "info", label: "Info", type: "color" },
            { name: "success", label: "Success", type: "color" },
            { name: "warning", label: "Warning", type: "color" },
            { name: "error", label: "Error", type: "color" }
          ] },
          { name: "darkColors", label: "Dark Mode Overrides", type: "group", fields: [
            { name: "primary", label: "Primary", type: "color" },
            { name: "secondary", label: "Secondary", type: "color" },
            { name: "accent", label: "Accent", type: "color" },
            { name: "neutral", label: "Neutral", type: "color" },
            { name: "base-100", label: "Base 100", type: "color" },
            { name: "base-200", label: "Base 200", type: "color" },
            { name: "base-300", label: "Base 300", type: "color" },
            { name: "info", label: "Info", type: "color" },
            { name: "success", label: "Success", type: "color" },
            { name: "warning", label: "Warning", type: "color" },
            { name: "error", label: "Error", type: "color" }
          ] },
          { name: "advanced", label: "Advanced", type: "group", fields: [
            { name: "rounded-box", label: "Border Radius (Cards & Modals)", type: "text", defaultValue: "1rem" },
            { name: "rounded-btn", label: "Border Radius (Buttons)", type: "text", defaultValue: "0.5rem" },
            { name: "rounded-badge", label: "Border Radius (Badges)", type: "text", defaultValue: "1.9rem" },
            { name: "animation-btn", label: "Animation Duration (Buttons)", type: "text", defaultValue: "0.25s" },
            { name: "animation-input", label: "Animation Duration (Inputs)", type: "text", defaultValue: "0.2s" },
            { name: "btn-focus-scale", label: "Button Focus Scale", type: "text", defaultValue: "0.95" },
            { name: "border-btn", label: "Button Border Width", type: "text", defaultValue: "1px" },
            { name: "tab-border", label: "Tab Border Width", type: "text", defaultValue: "1px" },
            { name: "tab-radius", label: "Tab Border Radius", type: "text", defaultValue: "0.5rem" }
          ] }
        ]
      };
      updatedConfig.globals = [...updatedConfig.globals || [], themeGlobal];
      return updatedConfig;
    },
    adminUi: [
      {
        path: "daisyui-theme",
        label: "DaisyUI Theme",
        componentPath: "@talisman-cms/plugin-ui-daisyui/admin/ThemeBuilder"
      }
    ],
    routes: [
      {
        path: "/admin/daisyui-preview",
        entrypoint: routeEntrypoint("preview.astro"),
        prerender: false
      }
    ],
    endpoints: [
      {
        path: "/daisyui/theme",
        entrypoint: routeEntrypoint("api-theme.ts")
      },
      {
        path: "/daisyui/layouts",
        entrypoint: routeEntrypoint("api-layouts.ts")
      }
    ]
  };
}
export {
  buildThemeCss,
  clampInteger,
  cssUrl,
  daisyUiLibrary,
  daisyUiPlugin2 as daisyUiPlugin,
  safeCssLength,
  safeHref,
  sanitizeThemeSettings
};
