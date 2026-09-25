"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/generated.ts
var generated_exports = {};
__export(generated_exports, {
  starwindUiLibrary: () => starwindUiLibrary,
  starwindUiPlugin: () => starwindUiPlugin
});
module.exports = __toCommonJS(generated_exports);
var libraryRequirements = [
  {
    "kind": "package",
    "label": "Install Starwind UI",
    "value": "@starwind/ui",
    "optional": true
  },
  {
    "kind": "css",
    "label": "Import Starwind styles",
    "value": "Ensure the Starwind CSS layer is available to the site",
    "optional": true
  }
];
var blockAdapters = [
  {
    "block": {
      "slug": "starwindMetricsBand",
      "name": "Metrics Band",
      "description": "Dense metrics row backed by reusable stat components.",
      "category": "Data",
      "fields": [
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "description",
          "label": "Description",
          "type": "textarea"
        }
      ],
      "componentSlots": [
        {
          "name": "items",
          "label": "Metric Items",
          "hasMany": true,
          "componentsFromPlugins": [
            "starwindMetric"
          ],
          "allowInline": true,
          "allowReferences": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-starwind",
        "library": "starwind",
        "item": "metrics-band"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-starwind/renderers/StarwindMetricsBand.astro"
    }
  },
  {
    "block": {
      "slug": "starwindSplitFeature",
      "name": "Split Feature",
      "description": "Editorial split section with nested links and metrics.",
      "category": "Feature",
      "fields": [
        {
          "name": "eyebrow",
          "label": "Eyebrow",
          "type": "text"
        },
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "description",
          "label": "Description",
          "type": "textarea",
          "required": true
        },
        {
          "name": "mediaUrl",
          "label": "Media URL",
          "type": "text"
        }
      ],
      "componentSlots": [
        {
          "name": "links",
          "label": "Links",
          "hasMany": true,
          "componentsFromPlugins": [
            "starwindTextLink"
          ],
          "allowInline": true,
          "allowReferences": true
        },
        {
          "name": "metrics",
          "label": "Metrics",
          "hasMany": true,
          "componentsFromPlugins": [
            "starwindMetric"
          ],
          "allowInline": true,
          "allowReferences": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-starwind",
        "library": "starwind",
        "item": "split-feature"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-starwind/renderers/StarwindSplitFeature.astro"
    }
  }
];
var componentAdapters = [
  {
    "component": {
      "slug": "starwindMetric",
      "name": "Metric Stat",
      "description": "Compact metric with label and summary.",
      "category": "Data",
      "fields": [
        {
          "name": "value",
          "label": "Value",
          "type": "text",
          "required": true
        },
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "summary",
          "label": "Summary",
          "type": "textarea"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-starwind",
        "library": "starwind",
        "item": "metric"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-starwind/renderers/StarwindMetric.astro"
    },
    "presets": [
      {
        "id": "starwind-growth-metric",
        "label": "Growth Metric",
        "variant": "growth",
        "props": {
          "value": "42%",
          "label": "Year-over-year growth",
          "summary": "Used in launch and investor storytelling sections."
        },
        "componentSlug": "starwindMetric",
        "libraryId": "starwind"
      }
    ]
  },
  {
    "component": {
      "slug": "starwindTextLink",
      "name": "Text Link",
      "description": "Editorial style text link for nested action rows.",
      "category": "Actions",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "href",
          "label": "URL",
          "type": "text",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-starwind",
        "library": "starwind",
        "item": "text-link"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-starwind/renderers/StarwindTextLink.astro"
    }
  }
];
var presets = componentAdapters.flatMap((component) => component.presets || []);
function starwindUiLibrary() {
  return {
    id: "starwind",
    name: "Starwind UI",
    requirements: libraryRequirements,
    blocks: blockAdapters,
    components: componentAdapters,
    presets
  };
}
function starwindUiPlugin() {
  return {
    name: "@talisman-cms/plugin-ui-starwind",
    onInit: (config) => config,
    uiLibraries: [starwindUiLibrary()]
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  starwindUiLibrary,
  starwindUiPlugin
});
