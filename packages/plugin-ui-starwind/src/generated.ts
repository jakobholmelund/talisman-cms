import type { Plugin, UiLibraryBlockAdapter, UiLibraryComponentAdapter, UiLibraryDefinition } from 'talisman-cms';

const libraryRequirements = [
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
] satisfies UiLibraryDefinition['requirements'];
const blockAdapters = [
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
] satisfies UiLibraryBlockAdapter[];
const componentAdapters = [
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
] satisfies UiLibraryComponentAdapter[];
const presets = componentAdapters.flatMap((component) => component.presets || []);

export function starwindUiLibrary(): UiLibraryDefinition {
  return {
    id: "starwind",
    name: "Starwind UI",
    requirements: libraryRequirements,
    blocks: blockAdapters,
    components: componentAdapters,
    presets,
  };
}

export function starwindUiPlugin(): Plugin {
  return {
    name: "@talisman-cms/plugin-ui-starwind",
    onInit: (config: any) => config,
    uiLibraries: [starwindUiLibrary()],
  };
}
