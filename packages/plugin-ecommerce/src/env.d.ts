/// <reference types="astro/client" />

declare module 'astro:actions' {
  export * from 'astro/actions/runtime/entrypoints/server.js';
}

/** Provided by ecommercePlugin() to its admin screens. */
declare module 'virtual:talisman-cms/ecommerce-admin' {
  export const adminTestCheckout: boolean;
}

/** Provided by ecommercePlugin() to server code: the exports of its `emailTemplates` module, or null. */
declare module 'virtual:talisman-cms/ecommerce-emails' {
  export const emailTemplates: Record<string, unknown> | null;
}

// The admin code imports core UI modules (talisman-cms/ui/*), which read these core virtual modules.
// The types mirror packages/talisman-cms/src/virtual-modules.d.ts.
declare module 'virtual:talisman-cms/config' {
  import type { CollectionConfig, GlobalConfig } from 'talisman-cms';
  export const adminPath: string;
  export const collections: CollectionConfig[];
  export const globals: GlobalConfig[];
  export const adminLinks: { section: string; label: string; description: string; href: string }[];
}

declare module 'virtual:talisman-cms/admin-extensions' {
  import type { ComponentType, LazyExoticComponent } from 'react';
  export const adminExtensions: Array<{ path: string; label: string; section: string | null; plugin: string; component: LazyExoticComponent<ComponentType<any>> }>;
  export const adminSections: Array<{
    id: string; label: string; description: string | null; icon: string | null; adminOnly: boolean;
    emptyState: { title: string; body: string } | null; plugin: string;
    workspace: LazyExoticComponent<ComponentType<any>> | null;
  }>;
  export const adminEditorPanels: Array<{
    id: string; placement: 'before-fields' | 'after-form'; sections: string[] | null; slugs: string[] | null;
    plugin: string; component: LazyExoticComponent<ComponentType<any>>;
  }>;
  export const adminEntryDescribers: Array<{ plugin: string; module: Record<string, unknown> }>;
}
