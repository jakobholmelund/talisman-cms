import {
  daisyUiLibrary,
  daisyUiPlugin
} from "./chunk-KXZTZRFF.js";

// src/index.ts
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
        entrypoint: "@talisman-cms/plugin-ui-daisyui/routes/preview.astro",
        prerender: false
      }
    ],
    endpoints: [
      {
        path: "/daisyui/theme",
        entrypoint: "@talisman-cms/plugin-ui-daisyui/routes/api-theme.ts"
      },
      {
        path: "/daisyui/layouts",
        entrypoint: "@talisman-cms/plugin-ui-daisyui/routes/api-layouts.ts"
      }
    ]
  };
}
export {
  daisyUiLibrary,
  daisyUiPlugin2 as daisyUiPlugin
};
