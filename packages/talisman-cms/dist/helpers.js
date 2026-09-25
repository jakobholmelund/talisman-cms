import "./chunk-MLKGABMK.js";

// src/helpers.ts
function edit(collectionSlug, entryId, fieldPath) {
  return {
    "data-talisman-collection": collectionSlug,
    "data-talisman-entry": entryId,
    ...fieldPath ? { "data-talisman-path": fieldPath } : {}
  };
}
var MEDIA_IMAGE_WIDTHS = [320, 640, 960, 1280, 1920];
function getMediaImageSrcSet(src, widths = MEDIA_IMAGE_WIDTHS) {
  if (!src.startsWith("/api/media/")) return void 0;
  const url = new URL(src, "https://talisman.invalid");
  if (!/^\/api\/media\/media_[A-Za-z0-9_-]+$/.test(url.pathname)) return void 0;
  const variants = widths.filter((width) => MEDIA_IMAGE_WIDTHS.includes(width));
  if (variants.length === 0) return void 0;
  return variants.map((width) => {
    const variant = new URL(url);
    variant.searchParams.set("w", String(width));
    return `${variant.pathname}${variant.search} ${width}w`;
  }).join(", ");
}
function createCollectionRepeaterBlock(options) {
  const layouts = options.layouts && options.layouts.length > 0 ? options.layouts : ["grid", "list"];
  const defaultLayout = options.defaultLayout && layouts.includes(options.defaultLayout) ? options.defaultLayout : layouts[0];
  const relationTargets = Array.isArray(options.relationTo) ? options.relationTo : [options.relationTo];
  return {
    slug: options.slug,
    name: options.name,
    description: options.description || `Repeat selected entries from the ${relationTargets.join(", ")} collection${relationTargets.length > 1 ? "s" : ""}.`,
    category: options.category || "Content",
    fields: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Section Title", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
      {
        name: "items",
        label: options.itemLabel || "Items",
        type: "relation",
        relationTo: options.relationTo,
        hasMany: true,
        required: true
      },
      {
        name: "layout",
        label: "Layout",
        type: "select",
        options: layouts,
        defaultValue: defaultLayout,
        required: true
      },
      {
        name: "emptyMessage",
        label: "Empty Message",
        type: "text",
        defaultValue: options.emptyMessageDefault || "No items selected yet."
      },
      {
        name: "ctaLabel",
        label: "CTA Label",
        type: "text",
        defaultValue: options.ctaLabelDefault
      },
      {
        name: "ctaHref",
        label: "CTA URL",
        type: "text",
        defaultValue: options.ctaHrefDefault
      }
    ]
  };
}
function createLayoutSlot(name, label, options) {
  return {
    name,
    label,
    hasMany: true,
    componentsFromPlugins: options.componentsFromPlugins ?? (options.componentsFromLibraries?.length ? void 0 : true),
    componentsFromLibraries: options.componentsFromLibraries,
    allowInline: options.allowInline ?? true,
    allowReferences: options.allowReferences ?? true
  };
}
function createBaseLayoutFields() {
  return [
    { name: "eyebrow", label: "Eyebrow", type: "text" },
    { name: "title", label: "Title", type: "text" },
    { name: "description", label: "Description", type: "textarea" }
  ];
}
function createSectionLayoutBlock(options = {}) {
  return {
    slug: options.slug || "sectionLayout",
    name: options.name || "Section Layout",
    category: options.category || "Layout",
    description: options.description || "Section shell with intro copy and a flexible content area.",
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot("content", "Content", options)
    ]
  };
}
function createTwoColumnLayoutBlock(options = {}) {
  return {
    slug: options.slug || "twoColumnLayout",
    name: options.name || "Two Column Layout",
    category: options.category || "Layout",
    description: options.description || "Section with intro copy and two component columns.",
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot("left", "Left Column", options),
      createLayoutSlot("right", "Right Column", options)
    ]
  };
}
function createThreeColumnLayoutBlock(options = {}) {
  return {
    slug: options.slug || "threeColumnLayout",
    name: options.name || "Three Column Layout",
    category: options.category || "Layout",
    description: options.description || "Section with intro copy and three component columns.",
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot("left", "Left Column", options),
      createLayoutSlot("center", "Center Column", options),
      createLayoutSlot("right", "Right Column", options)
    ]
  };
}
function getCollectionRepeaterItems(block) {
  return (block?.items || []).filter(
    (item) => Boolean(item) && typeof item === "object" && "data" in item
  );
}
function getCollectionRepeaterViewModel(block) {
  return {
    eyebrow: block?.eyebrow || "",
    title: block?.title || "",
    description: block?.description || "",
    layout: block?.layout || "grid",
    items: getCollectionRepeaterItems(block),
    emptyMessage: block?.emptyMessage || "No items selected yet.",
    cta: block?.ctaLabel && block?.ctaHref ? {
      label: block.ctaLabel,
      href: block.ctaHref
    } : null,
    settings: block?._settings || {}
  };
}
export {
  createCollectionRepeaterBlock,
  createSectionLayoutBlock,
  createThreeColumnLayoutBlock,
  createTwoColumnLayoutBlock,
  edit,
  getCollectionRepeaterItems,
  getCollectionRepeaterViewModel,
  getMediaImageSrcSet
};
