// src/generated.ts
var libraryRequirements = [
  {
    "kind": "tailwind",
    "label": "Scan the Talisman composition renderers with Tailwind CSS",
    "value": 'Tailwind v4: add @source "../../node_modules/@talisman-cms/plugin-ui-starwind/src/renderers"; in src/styles/global.css'
  }
];
var blockAdapters = [
  {
    "block": {
      "slug": "starwindMetricsBand",
      "name": "Metrics Band (custom)",
      "description": "Custom Talisman composition. Dense metrics row backed by reusable stat components.",
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
      "name": "Split Feature (custom)",
      "description": "Custom Talisman composition. Editorial split section with nested links and metrics.",
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
        },
        {
          "name": "mediaAlt",
          "label": "Image description (leave empty for decorative images)",
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
      "name": "Metric Stat (custom)",
      "description": "Custom Talisman composition. Compact metric with label and summary.",
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
      "name": "Text Link (custom)",
      "description": "Custom Talisman composition. Editorial style text link for nested action rows.",
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
    name: "Starwind (Talisman compositions)",
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

export {
  starwindUiLibrary,
  starwindUiPlugin
};
