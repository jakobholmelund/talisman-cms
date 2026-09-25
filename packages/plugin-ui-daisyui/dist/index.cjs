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

// src/index.ts
var index_exports = {};
__export(index_exports, {
  daisyUiLibrary: () => daisyUiLibrary,
  daisyUiPlugin: () => daisyUiPlugin2
});
module.exports = __toCommonJS(index_exports);

// src/generated.ts
var libraryRequirements = [
  {
    "kind": "package",
    "label": "Install daisyUI",
    "value": "daisyui"
  },
  {
    "kind": "tailwind",
    "label": "Enable daisyUI plugin",
    "value": "Add daisyUI to your Tailwind or Astro CSS pipeline"
  },
  {
    "kind": "theme",
    "label": "Configure a theme",
    "value": "Set a daisyUI theme or rely on the default theme",
    "optional": true
  }
];
var blockAdapters = [
  {
    "block": {
      "slug": "daisyFeatureGrid",
      "name": "Feature Grid",
      "description": "Grid layout composed from reusable feature-card components.",
      "category": "Content",
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
          "label": "Feature Cards",
          "hasMany": true,
          "componentsFromPlugins": [
            "daisyFeatureCard"
          ],
          "allowInline": true,
          "allowReferences": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "grid"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFeatureGrid.astro"
    }
  },
  {
    "block": {
      "slug": "daisyHeroBanner",
      "name": "Hero Banner",
      "description": "Large hero section with supporting actions slot.",
      "category": "Hero",
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
          "name": "imageUrl",
          "label": "Image URL",
          "type": "text"
        },
        {
          "name": "alignment",
          "label": "Alignment",
          "type": "select",
          "options": [
            "side-by-side (image right)",
            "side-by-side (image left)",
            "centered"
          ],
          "defaultValue": "side-by-side (image right)",
          "required": true
        },
        {
          "name": "overlay",
          "label": "Image Overlay",
          "type": "boolean",
          "defaultValue": false
        }
      ],
      "componentSlots": [
        {
          "name": "actions",
          "label": "Actions",
          "description": "Action buttons shown beneath the copy.",
          "hasMany": true,
          "componentsFromPlugins": [
            "daisyButtonAction",
            "daisyBadgePill"
          ],
          "allowInline": true,
          "allowReferences": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "hero"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyHeroBanner.astro"
    }
  }
];
var componentAdapters = [
  {
    "component": {
      "slug": "daisyAccordionList",
      "name": "Accordion List",
      "description": "Accordion list with item title, content, and default-open state.",
      "category": "Data display",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "title",
              "label": "Title",
              "type": "text",
              "required": true
            },
            {
              "name": "content",
              "label": "Content",
              "type": "textarea",
              "required": true
            },
            {
              "name": "open",
              "label": "Open by Default",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "accordion"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyAccordionList.astro"
    }
  },
  {
    "component": {
      "slug": "daisyAlertNotice",
      "name": "Alert Notice",
      "description": "Status message banner with tone and optional supporting text.",
      "category": "Feedback",
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
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "info",
            "success",
            "warning",
            "error"
          ],
          "defaultValue": "info",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "alert"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyAlertNotice.astro"
    }
  },
  {
    "component": {
      "slug": "daisyAvatarProfile",
      "name": "Avatar Profile",
      "description": "Avatar image with selectable size, shape, and fallback initials.",
      "category": "Data display",
      "fields": [
        {
          "name": "imageUrl",
          "label": "Image URL",
          "type": "text"
        },
        {
          "name": "alt",
          "label": "Alt Text",
          "type": "text",
          "defaultValue": "Avatar"
        },
        {
          "name": "fallback",
          "label": "Fallback Label",
          "type": "text",
          "defaultValue": "?"
        },
        {
          "name": "size",
          "label": "Size",
          "type": "select",
          "options": [
            "sm",
            "md",
            "lg"
          ],
          "defaultValue": "md",
          "required": true
        },
        {
          "name": "shape",
          "label": "Shape",
          "type": "select",
          "options": [
            "circle",
            "squircle",
            "rounded"
          ],
          "defaultValue": "circle",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "avatar"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyAvatarProfile.astro"
    }
  },
  {
    "component": {
      "slug": "daisyBadgePill",
      "name": "Badge Pill",
      "description": "Inline badge for highlights and metadata.",
      "category": "Feedback",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "accent",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "badge"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyBadgePill.astro"
    }
  },
  {
    "component": {
      "slug": "daisyBreadcrumbTrail",
      "name": "Breadcrumb Trail",
      "description": "Breadcrumb navigation with explicit labels and links.",
      "category": "Navigation",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
              "type": "text"
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "breadcrumbs"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyBreadcrumbTrail.astro"
    }
  },
  {
    "component": {
      "slug": "daisyButtonAction",
      "name": "Button Action",
      "description": "CTA button for hero and promo sections.",
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
        },
        {
          "name": "style",
          "label": "Style",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "ghost"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "size",
          "label": "Size",
          "type": "select",
          "options": [
            "sm",
            "md",
            "lg"
          ],
          "defaultValue": "md",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "button"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyButtonAction.astro"
    },
    "presets": [
      {
        "id": "daisy-primary-cta",
        "label": "Primary CTA",
        "variant": "primary",
        "props": {
          "label": "Get started",
          "href": "/get-started",
          "style": "primary",
          "size": "lg"
        },
        "componentSlug": "daisyButtonAction",
        "libraryId": "daisyui"
      }
    ]
  },
  {
    "component": {
      "slug": "daisyCalendarCard",
      "name": "Calendar Card",
      "description": "Simple calendar card with month heading and day cells.",
      "category": "Data input",
      "fields": [
        {
          "name": "month",
          "label": "Month Label",
          "type": "text",
          "required": true
        },
        {
          "name": "days",
          "label": "Days",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Day Label",
              "type": "text",
              "required": true
            },
            {
              "name": "meta",
              "label": "Meta",
              "type": "text"
            },
            {
              "name": "highlight",
              "label": "Highlight",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "calendar"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyCalendarCard.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFeatureCard",
      "name": "Feature Card",
      "description": "Card with icon, title, description, and optional CTA.",
      "category": "Content",
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
          "name": "href",
          "label": "URL",
          "type": "text"
        },
        {
          "name": "ctaLabel",
          "label": "CTA Label",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "card"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFeatureCard.astro"
    }
  },
  {
    "component": {
      "slug": "daisyCarouselStrip",
      "name": "Carousel Strip",
      "description": "Carousel preview built from explicit slides.",
      "category": "Data display",
      "fields": [
        {
          "name": "items",
          "label": "Slides",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "carousel"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyCarouselStrip.astro"
    }
  },
  {
    "component": {
      "slug": "daisyChatBubble",
      "name": "Chat Bubble",
      "description": "Single conversation bubble with side alignment and tone.",
      "category": "Data display",
      "fields": [
        {
          "name": "author",
          "label": "Author",
          "type": "text"
        },
        {
          "name": "message",
          "label": "Message",
          "type": "textarea",
          "required": true
        },
        {
          "name": "side",
          "label": "Side",
          "type": "select",
          "options": [
            "start",
            "end"
          ],
          "defaultValue": "start",
          "required": true
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "neutral",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "chat-bubble"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyChatBubble.astro"
    }
  },
  {
    "component": {
      "slug": "daisyCheckboxField",
      "name": "Checkbox Field",
      "description": "Checkbox input preview.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "checked",
          "label": "Checked",
          "type": "boolean",
          "defaultValue": false
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "checkbox"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyCheckboxField.astro"
    }
  },
  {
    "component": {
      "slug": "daisyCollapsePanel",
      "name": "Collapse Panel",
      "description": "Single disclosure panel with title and content.",
      "category": "Data display",
      "fields": [
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "content",
          "label": "Content",
          "type": "textarea",
          "required": true
        },
        {
          "name": "open",
          "label": "Open by Default",
          "type": "boolean",
          "defaultValue": false
        },
        {
          "name": "style",
          "label": "Style",
          "type": "select",
          "options": [
            "arrow",
            "plus",
            "default"
          ],
          "defaultValue": "arrow",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "collapse"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyCollapsePanel.astro"
    }
  },
  {
    "component": {
      "slug": "daisyCountdownTimer",
      "name": "Countdown Timer",
      "description": "Presentational countdown value with optional label.",
      "category": "Data display",
      "fields": [
        {
          "name": "value",
          "label": "Value",
          "type": "number",
          "required": true,
          "defaultValue": 12
        },
        {
          "name": "label",
          "label": "Label",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "countdown"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyCountdownTimer.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDiffCompare",
      "name": "Diff Compare",
      "description": "Before and after comparison with labels and text content.",
      "category": "Data display",
      "fields": [
        {
          "name": "beforeLabel",
          "label": "Before Label",
          "type": "text",
          "defaultValue": "Before"
        },
        {
          "name": "beforeText",
          "label": "Before Text",
          "type": "textarea",
          "required": true
        },
        {
          "name": "afterLabel",
          "label": "After Label",
          "type": "text",
          "defaultValue": "After"
        },
        {
          "name": "afterText",
          "label": "After Text",
          "type": "textarea",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "diff"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDiffCompare.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDividerRule",
      "name": "Divider Rule",
      "description": "Visual divider with optional label, tone, and vertical layout.",
      "category": "Layout",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "default",
            "primary",
            "secondary",
            "accent"
          ],
          "defaultValue": "default",
          "required": true
        },
        {
          "name": "direction",
          "label": "Direction",
          "type": "select",
          "options": [
            "horizontal",
            "vertical"
          ],
          "defaultValue": "horizontal",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "divider"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDividerRule.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDockNav",
      "name": "Dock Nav",
      "description": "Dock navigation with explicit items.",
      "category": "Navigation",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "dock"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDockNav.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDrawerShell",
      "name": "Drawer Shell",
      "description": "Drawer trigger and side panel with title and body copy.",
      "category": "Layout",
      "fields": [
        {
          "name": "buttonLabel",
          "label": "Button Label",
          "type": "text",
          "required": true,
          "defaultValue": "Open drawer"
        },
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "content",
          "label": "Content",
          "type": "textarea",
          "required": true
        },
        {
          "name": "side",
          "label": "Side",
          "type": "select",
          "options": [
            "start",
            "end"
          ],
          "defaultValue": "start",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "drawer"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDrawerShell.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDropdownMenu",
      "name": "Dropdown Menu",
      "description": "Dropdown trigger button with explicit menu items.",
      "category": "Actions",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "ghost"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "items",
          "label": "Menu Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "dropdown"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDropdownMenu.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFabButton",
      "name": "FAB Button",
      "description": "Floating action button with tone and position.",
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
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "position",
          "label": "Position",
          "type": "select",
          "options": [
            "bottom-end",
            "bottom-start",
            "top-end",
            "top-start"
          ],
          "defaultValue": "bottom-end",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "fab"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFabButton.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFieldsetGroup",
      "name": "Fieldset Group",
      "description": "Fieldset with explicit field labels and placeholders.",
      "category": "Data input",
      "fields": [
        {
          "name": "legend",
          "label": "Legend",
          "type": "text",
          "required": true
        },
        {
          "name": "hint",
          "label": "Hint",
          "type": "text"
        },
        {
          "name": "fields",
          "label": "Fields",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            },
            {
              "name": "placeholder",
              "label": "Placeholder",
              "type": "text"
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "fieldset"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFieldsetGroup.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFileInputField",
      "name": "File Input Field",
      "description": "File input preview with label and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "file-input"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFileInputField.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFilterChips",
      "name": "Filter Chips",
      "description": "Filter chip group with active item state.",
      "category": "Data input",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "filter"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFilterChips.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFooterLinks",
      "name": "Footer Links",
      "description": "Footer with brand title and link sections.",
      "category": "Layout",
      "fields": [
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "sections",
          "label": "Sections",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "title",
              "label": "Section Title",
              "type": "text",
              "required": true
            },
            {
              "name": "links",
              "label": "Links",
              "type": "array",
              "required": true,
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
              ]
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "footer"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFooterLinks.astro"
    }
  },
  {
    "component": {
      "slug": "daisyHoverTiltCard",
      "name": "Hover Tilt Card",
      "description": "Card preview with title and description.",
      "category": "Data display",
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
          "type": "textarea",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "hover-3d-card"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyHoverTiltCard.astro"
    }
  },
  {
    "component": {
      "slug": "daisyHoverGallery",
      "name": "Hover Gallery",
      "description": "Gallery grid built from explicit cards.",
      "category": "Data display",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "hover-gallery"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyHoverGallery.astro"
    }
  },
  {
    "component": {
      "slug": "daisyIndicatorBadge",
      "name": "Indicator Badge",
      "description": "Indicator badge over a simple label panel.",
      "category": "Layout",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "indicator",
          "label": "Indicator Text",
          "type": "text",
          "required": true,
          "defaultValue": "New"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "indicator"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyIndicatorBadge.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTextInput",
      "name": "Text Input",
      "description": "Text input preview with label, placeholder, and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "placeholder",
          "label": "Placeholder",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "input"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTextInput.astro"
    }
  },
  {
    "component": {
      "slug": "daisyJoinGroup",
      "name": "Join Group",
      "description": "Joined actions rendered from explicit item labels and links.",
      "category": "Layout",
      "fields": [
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "default",
            "primary",
            "secondary",
            "accent"
          ],
          "defaultValue": "default",
          "required": true
        },
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "join"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyJoinGroup.astro"
    }
  },
  {
    "component": {
      "slug": "daisyKeycap",
      "name": "Keycap",
      "description": "Keyboard shortcut token rendered with daisyUI kbd styles.",
      "category": "Data display",
      "fields": [
        {
          "name": "keys",
          "label": "Keys",
          "type": "text",
          "required": true
        },
        {
          "name": "size",
          "label": "Size",
          "type": "select",
          "options": [
            "sm",
            "md",
            "lg"
          ],
          "defaultValue": "md",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "kbd"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyKeycap.astro"
    }
  },
  {
    "component": {
      "slug": "daisyFieldLabel",
      "name": "Field Label",
      "description": "Label with optional supporting description.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "description",
          "label": "Description",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "label"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyFieldLabel.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTextLink",
      "name": "Text Link",
      "description": "Inline text link with daisyUI tone variants.",
      "category": "Navigation",
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
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "external",
          "label": "Open in New Tab",
          "type": "boolean",
          "defaultValue": false
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "link"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTextLink.astro"
    }
  },
  {
    "component": {
      "slug": "daisyItemList",
      "name": "Item List",
      "description": "List rows with title, description, and tone.",
      "category": "Data display",
      "fields": [
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "default",
            "primary",
            "secondary",
            "accent"
          ],
          "defaultValue": "default",
          "required": true
        },
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "list"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyItemList.astro"
    }
  },
  {
    "component": {
      "slug": "daisyLoadingIndicator",
      "name": "Loading Indicator",
      "description": "Inline loading state indicator with optional label.",
      "category": "Feedback",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text"
        },
        {
          "name": "style",
          "label": "Style",
          "type": "select",
          "options": [
            "spinner",
            "dots",
            "ring",
            "ball",
            "bars"
          ],
          "defaultValue": "spinner",
          "required": true
        },
        {
          "name": "size",
          "label": "Size",
          "type": "select",
          "options": [
            "sm",
            "md",
            "lg"
          ],
          "defaultValue": "md",
          "required": true
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "loading"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyLoadingIndicator.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMaskFrame",
      "name": "Mask Frame",
      "description": "Masked image using selected daisyUI mask shapes.",
      "category": "Layout",
      "fields": [
        {
          "name": "imageUrl",
          "label": "Image URL",
          "type": "text",
          "required": true
        },
        {
          "name": "alt",
          "label": "Alt Text",
          "type": "text",
          "defaultValue": "Masked image"
        },
        {
          "name": "shape",
          "label": "Shape",
          "type": "select",
          "options": [
            "squircle",
            "heart",
            "hexagon",
            "circle"
          ],
          "defaultValue": "squircle",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "mask"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMaskFrame.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMenuList",
      "name": "Menu List",
      "description": "Navigation list with explicit menu items and active state.",
      "category": "Navigation",
      "fields": [
        {
          "name": "direction",
          "label": "Direction",
          "type": "select",
          "options": [
            "vertical",
            "horizontal"
          ],
          "defaultValue": "vertical",
          "required": true
        },
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "menu"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMenuList.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMockupBrowser",
      "name": "Mockup Browser",
      "description": "Browser frame with toolbar URL and centered content.",
      "category": "Mockup",
      "fields": [
        {
          "name": "url",
          "label": "URL",
          "type": "text",
          "required": true
        },
        {
          "name": "content",
          "label": "Content",
          "type": "textarea",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "mockup-browser"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMockupBrowser.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMockupCode",
      "name": "Mockup Code",
      "description": "Code panel with optional language label and code content.",
      "category": "Mockup",
      "fields": [
        {
          "name": "language",
          "label": "Language",
          "type": "text"
        },
        {
          "name": "code",
          "label": "Code",
          "type": "textarea",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "mockup-code"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMockupCode.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMockupPhone",
      "name": "Mockup Phone",
      "description": "Phone frame with image preview or fallback content.",
      "category": "Mockup",
      "fields": [
        {
          "name": "imageUrl",
          "label": "Image URL",
          "type": "text"
        },
        {
          "name": "alt",
          "label": "Alt Text",
          "type": "text",
          "defaultValue": "Phone preview"
        },
        {
          "name": "content",
          "label": "Fallback Content",
          "type": "textarea"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "mockup-phone"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMockupPhone.astro"
    }
  },
  {
    "component": {
      "slug": "daisyMockupWindow",
      "name": "Mockup Window",
      "description": "Window frame with title and supporting copy.",
      "category": "Mockup",
      "fields": [
        {
          "name": "title",
          "label": "Title",
          "type": "text"
        },
        {
          "name": "content",
          "label": "Content",
          "type": "textarea",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "mockup-window"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyMockupWindow.astro"
    }
  },
  {
    "component": {
      "slug": "daisyModalDialog",
      "name": "Modal Dialog",
      "description": "Modal dialog with trigger text, body copy, and optional action link.",
      "category": "Actions",
      "fields": [
        {
          "name": "triggerLabel",
          "label": "Trigger Label",
          "type": "text",
          "required": true,
          "defaultValue": "Open dialog"
        },
        {
          "name": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "name": "content",
          "label": "Content",
          "type": "textarea",
          "required": true
        },
        {
          "name": "actionLabel",
          "label": "Action Label",
          "type": "text"
        },
        {
          "name": "actionHref",
          "label": "Action URL",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "modal"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyModalDialog.astro"
    }
  },
  {
    "component": {
      "slug": "daisyNavbarBar",
      "name": "Navbar Bar",
      "description": "Navbar with brand label and inline navigation items.",
      "category": "Navigation",
      "fields": [
        {
          "name": "brandLabel",
          "label": "Brand Label",
          "type": "text",
          "required": true
        },
        {
          "name": "brandHref",
          "label": "Brand URL",
          "type": "text",
          "required": true,
          "defaultValue": "/"
        },
        {
          "name": "items",
          "label": "Navigation Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "navbar"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyNavbarBar.astro"
    }
  },
  {
    "component": {
      "slug": "daisyPaginationNav",
      "name": "Pagination Nav",
      "description": "Pagination control built from explicit page items.",
      "category": "Navigation",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
              "type": "text"
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            },
            {
              "name": "disabled",
              "label": "Disabled",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "pagination"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyPaginationNav.astro"
    }
  },
  {
    "component": {
      "slug": "daisyProgressBar",
      "name": "Progress Bar",
      "description": "Linear progress bar with configurable value, max, and tone.",
      "category": "Feedback",
      "fields": [
        {
          "name": "value",
          "label": "Value",
          "type": "number",
          "required": true,
          "defaultValue": 35
        },
        {
          "name": "max",
          "label": "Maximum",
          "type": "number",
          "required": true,
          "defaultValue": 100
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "progress"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyProgressBar.astro"
    }
  },
  {
    "component": {
      "slug": "daisyRadialProgress",
      "name": "Radial Progress",
      "description": "Radial progress preview with optional label.",
      "category": "Feedback",
      "fields": [
        {
          "name": "value",
          "label": "Value",
          "type": "number",
          "required": true,
          "defaultValue": 75
        },
        {
          "name": "label",
          "label": "Label",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "radial-progress"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyRadialProgress.astro"
    }
  },
  {
    "component": {
      "slug": "daisyRadioGroup",
      "name": "Radio Group",
      "description": "Radio group preview with explicit options.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "value",
          "label": "Selected Value",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "options",
          "label": "Options",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            },
            {
              "name": "value",
              "label": "Value",
              "type": "text",
              "required": true
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "radio"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyRadioGroup.astro"
    }
  },
  {
    "component": {
      "slug": "daisyRangeSlider",
      "name": "Range Slider",
      "description": "Range slider preview with label and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "value",
          "label": "Value",
          "type": "number",
          "required": true,
          "defaultValue": 50
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "range"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyRangeSlider.astro"
    }
  },
  {
    "component": {
      "slug": "daisyRatingStars",
      "name": "Rating Stars",
      "description": "Star rating indicator with configurable maximum and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "value",
          "label": "Value",
          "type": "number",
          "required": true,
          "defaultValue": 3
        },
        {
          "name": "max",
          "label": "Maximum",
          "type": "number",
          "required": true,
          "defaultValue": 5
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "rating"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyRatingStars.astro"
    }
  },
  {
    "component": {
      "slug": "daisySelectField",
      "name": "Select Field",
      "description": "Select preview with label, options, and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "value",
          "label": "Selected Value",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        },
        {
          "name": "options",
          "label": "Options",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            },
            {
              "name": "value",
              "label": "Value",
              "type": "text",
              "required": true
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "select"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisySelectField.astro"
    }
  },
  {
    "component": {
      "slug": "daisySkeletonBlock",
      "name": "Skeleton Block",
      "description": "Placeholder block for loading states.",
      "category": "Feedback",
      "fields": [
        {
          "name": "width",
          "label": "Width",
          "type": "text",
          "defaultValue": "100%"
        },
        {
          "name": "height",
          "label": "Height",
          "type": "text",
          "defaultValue": "1rem"
        },
        {
          "name": "shape",
          "label": "Shape",
          "type": "select",
          "options": [
            "rounded",
            "circle",
            "square"
          ],
          "defaultValue": "rounded",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "skeleton"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisySkeletonBlock.astro"
    }
  },
  {
    "component": {
      "slug": "daisyStackDeck",
      "name": "Stack Deck",
      "description": "Stacked card deck built from explicit items.",
      "category": "Layout",
      "fields": [
        {
          "name": "items",
          "label": "Items",
          "type": "array",
          "required": true,
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
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "stack"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyStackDeck.astro"
    }
  },
  {
    "component": {
      "slug": "daisyStatCard",
      "name": "Stat Card",
      "description": "Single stat summary with label, value, description, and tone.",
      "category": "Data display",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "value",
          "label": "Value",
          "type": "text",
          "required": true
        },
        {
          "name": "description",
          "label": "Description",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "stat"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyStatCard.astro"
    }
  },
  {
    "component": {
      "slug": "daisyStatusDot",
      "name": "Status Dot",
      "description": "Status indicator with semantic tone and optional label.",
      "category": "Data display",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text"
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "success",
            "warning",
            "error",
            "info",
            "neutral"
          ],
          "defaultValue": "success",
          "required": true
        },
        {
          "name": "size",
          "label": "Size",
          "type": "select",
          "options": [
            "sm",
            "md",
            "lg"
          ],
          "defaultValue": "md",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "status"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyStatusDot.astro"
    }
  },
  {
    "component": {
      "slug": "daisyStepsList",
      "name": "Steps List",
      "description": "Vertical or responsive step list rendered with daisyUI steps.",
      "category": "Navigation",
      "fields": [
        {
          "name": "items",
          "label": "Steps",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            },
            {
              "name": "tone",
              "label": "Tone",
              "type": "select",
              "options": [
                "primary",
                "secondary",
                "accent",
                "neutral"
              ],
              "defaultValue": "primary",
              "required": true
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "steps"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyStepsList.astro"
    }
  },
  {
    "component": {
      "slug": "daisySwapToggle",
      "name": "Swap Toggle",
      "description": "Toggle label swap with semantic tone.",
      "category": "Actions",
      "fields": [
        {
          "name": "onLabel",
          "label": "On Label",
          "type": "text",
          "required": true,
          "defaultValue": "On"
        },
        {
          "name": "offLabel",
          "label": "Off Label",
          "type": "text",
          "required": true,
          "defaultValue": "Off"
        },
        {
          "name": "active",
          "label": "Active",
          "type": "boolean",
          "defaultValue": false
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "swap"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisySwapToggle.astro"
    }
  },
  {
    "component": {
      "slug": "daisyDataTable",
      "name": "Data Table",
      "description": "Table with explicit columns and row objects.",
      "category": "Data display",
      "fields": [
        {
          "name": "zebra",
          "label": "Zebra Rows",
          "type": "boolean",
          "defaultValue": true
        },
        {
          "name": "columns",
          "label": "Columns",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "key",
              "label": "Key",
              "type": "text",
              "required": true
            },
            {
              "name": "label",
              "label": "Label",
              "type": "text",
              "required": true
            }
          ]
        },
        {
          "name": "rows",
          "label": "Rows",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "name",
              "label": "Name",
              "type": "text"
            },
            {
              "name": "role",
              "label": "Role",
              "type": "text"
            },
            {
              "name": "email",
              "label": "Email",
              "type": "text"
            },
            {
              "name": "status",
              "label": "Status",
              "type": "text"
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "table"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyDataTable.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTabsNav",
      "name": "Tabs Nav",
      "description": "Static tabs row built from explicit items.",
      "category": "Navigation",
      "fields": [
        {
          "name": "style",
          "label": "Style",
          "type": "select",
          "options": [
            "boxed",
            "bordered",
            "lifted"
          ],
          "defaultValue": "boxed",
          "required": true
        },
        {
          "name": "items",
          "label": "Tabs",
          "type": "array",
          "required": true,
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
              "type": "text"
            },
            {
              "name": "active",
              "label": "Active",
              "type": "boolean",
              "defaultValue": false
            },
            {
              "name": "disabled",
              "label": "Disabled",
              "type": "boolean",
              "defaultValue": false
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "tabs"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTabsNav.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTextRotate",
      "name": "Text Rotate",
      "description": "Inline text sequence with prefix, words, and suffix.",
      "category": "Data display",
      "fields": [
        {
          "name": "prefix",
          "label": "Prefix",
          "type": "text"
        },
        {
          "name": "words",
          "label": "Words",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "label",
              "label": "Word",
              "type": "text",
              "required": true
            }
          ]
        },
        {
          "name": "suffix",
          "label": "Suffix",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "text-rotate"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTextRotate.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTextareaField",
      "name": "Textarea Field",
      "description": "Textarea preview with label and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "placeholder",
          "label": "Placeholder",
          "type": "text"
        },
        {
          "name": "rows",
          "label": "Rows",
          "type": "number",
          "required": true,
          "defaultValue": 4
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "textarea"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTextareaField.astro"
    }
  },
  {
    "component": {
      "slug": "daisyThemeController",
      "name": "Theme Controller",
      "description": "Theme preview radio controller with label.",
      "category": "Actions",
      "fields": [
        {
          "name": "theme",
          "label": "Theme",
          "type": "select",
          "options": [
            "light",
            "dark",
            "cupcake",
            "business"
          ],
          "defaultValue": "light",
          "required": true
        },
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "defaultValue": "Preview theme"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "theme-controller"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyThemeController.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTimelineTrack",
      "name": "Timeline Track",
      "description": "Vertical timeline built from explicit milestone items.",
      "category": "Data display",
      "fields": [
        {
          "name": "items",
          "label": "Timeline Items",
          "type": "array",
          "required": true,
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
              "type": "textarea"
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "timeline"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTimelineTrack.astro"
    }
  },
  {
    "component": {
      "slug": "daisyToastStack",
      "name": "Toast Stack",
      "description": "Toast stack with multiple messages and semantic tones.",
      "category": "Feedback",
      "fields": [
        {
          "name": "position",
          "label": "Position",
          "type": "select",
          "options": [
            "top-start",
            "top-end",
            "bottom-start",
            "bottom-end"
          ],
          "defaultValue": "top-end",
          "required": true
        },
        {
          "name": "items",
          "label": "Toast Items",
          "type": "array",
          "required": true,
          "fields": [
            {
              "name": "message",
              "label": "Message",
              "type": "text",
              "required": true
            },
            {
              "name": "tone",
              "label": "Tone",
              "type": "select",
              "options": [
                "info",
                "success",
                "warning",
                "error"
              ],
              "defaultValue": "info",
              "required": true
            }
          ]
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "toast"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyToastStack.astro"
    }
  },
  {
    "component": {
      "slug": "daisyToggleSwitch",
      "name": "Toggle Switch",
      "description": "Toggle switch preview with label and tone.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "checked",
          "label": "Checked",
          "type": "boolean",
          "defaultValue": false
        },
        {
          "name": "tone",
          "label": "Tone",
          "type": "select",
          "options": [
            "primary",
            "secondary",
            "accent",
            "neutral"
          ],
          "defaultValue": "primary",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "toggle"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyToggleSwitch.astro"
    }
  },
  {
    "component": {
      "slug": "daisyTooltipHint",
      "name": "Tooltip Hint",
      "description": "Inline tooltip trigger with configurable message and position.",
      "category": "Feedback",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "message",
          "label": "Message",
          "type": "text",
          "required": true
        },
        {
          "name": "position",
          "label": "Position",
          "type": "select",
          "options": [
            "top",
            "bottom",
            "left",
            "right"
          ],
          "defaultValue": "top",
          "required": true
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "tooltip"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyTooltipHint.astro"
    }
  },
  {
    "component": {
      "slug": "daisyValidatorMessage",
      "name": "Validator Message",
      "description": "Input validator preview with semantic message state.",
      "category": "Data input",
      "fields": [
        {
          "name": "label",
          "label": "Label",
          "type": "text",
          "required": true
        },
        {
          "name": "value",
          "label": "Value",
          "type": "text"
        },
        {
          "name": "state",
          "label": "State",
          "type": "select",
          "options": [
            "success",
            "warning",
            "error"
          ],
          "defaultValue": "success",
          "required": true
        },
        {
          "name": "message",
          "label": "Message",
          "type": "text"
        }
      ],
      "source": {
        "plugin": "@talisman-cms/plugin-ui-daisyui",
        "library": "daisyui",
        "item": "validator"
      }
    },
    "renderer": {
      "modulePath": "@talisman-cms/plugin-ui-daisyui/renderers/DaisyValidatorMessage.astro"
    }
  }
];
var presets = componentAdapters.flatMap((component) => component.presets || []);
function daisyUiLibrary() {
  return {
    id: "daisyui",
    name: "daisyUI",
    requirements: libraryRequirements,
    blocks: blockAdapters,
    components: componentAdapters,
    presets
  };
}
function daisyUiPlugin() {
  return {
    name: "@talisman-cms/plugin-ui-daisyui",
    onInit: (config) => config,
    uiLibraries: [daisyUiLibrary()]
  };
}

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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  daisyUiLibrary,
  daisyUiPlugin
});
