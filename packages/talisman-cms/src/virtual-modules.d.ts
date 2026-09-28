declare module 'virtual:talisman-cms/auth' {
  import type { TalismanAuthAdapter } from './auth/types';
  export const authConfigured: boolean;
  export const authAdapter: TalismanAuthAdapter | null;
}

/**
 * Server code gets the full configuration. The admin SPA's browser bundle is public, so there
 * `collections` and `globals` are a client-safe projection (no `runtimeHooks`, and nothing that looks
 * like a secret) and `publishing` is not exported.
 */
declare module 'virtual:talisman-cms/config' {
  import type { AdminSection, CollectionConfig, GlobalConfig, UiLibraryDefinition } from './types';
  export const adminPath: string;
  export const collections: CollectionConfig[];
  export const globals: GlobalConfig[];
  export const adminLinks: { section: AdminSection; label: string; description: string; href: string }[];
  /** The ids of the admin sections plugins registered (Plugin.adminSections). */
  export const adminSections: string[];
  export const uiLibraries: Array<Pick<UiLibraryDefinition, 'id' | 'name' | 'requirements' | 'presets'> & {
    blockSlugs: string[];
    componentSlugs: string[];
  }>;
  /** Server only: the plugin settings the admin page exposes as meta tags. */
  export const adminSettings: string[];
  /** Server only. */
  export const publishing: {
    workflowBinding: string;
  };
}

/**
 * The admin SPA's registry of plugin screens (see buildAdminExtensionsModule in integration.ts).
 * Page, workspace and panel components are React.lazy components.
 */
declare module 'virtual:talisman-cms/admin-extensions' {
  import type { ComponentType, LazyExoticComponent } from 'react';
  import type { AdminEditorPanelDefinition, AdminSectionDefinition } from './types';
  export const adminExtensions: Array<{
    path: string;
    label: string;
    section: string | null;
    plugin: string;
    component: LazyExoticComponent<ComponentType<any>>;
  }>;
  export const adminSections: Array<{
    id: string;
    label: string;
    description: string | null;
    icon: string | null;
    adminOnly: boolean;
    emptyState: AdminSectionDefinition['emptyState'] | null;
    plugin: string;
    workspace: LazyExoticComponent<ComponentType<any>> | null;
  }>;
  export const adminEditorPanels: Array<{
    id: string;
    placement: AdminEditorPanelDefinition['placement'];
    sections: string[] | null;
    slugs: string[] | null;
    plugin: string;
    component: LazyExoticComponent<ComponentType<any>>;
  }>;
  export const adminEntryDescribers: Array<{
    plugin: string;
    module: Record<string, unknown>;
  }>;
}

declare module 'virtual:talisman-cms/protected-routes' {
  export const adminPath: string;
  /** Route patterns of plugin endpoints and admin-path pages that require a CMS session. */
  export const protectedRoutes: Record<string, 'endpoint' | 'page'>;
}

declare module 'virtual:talisman-cms/email' {
  import type { EmailProviderFactory } from './email/types';
  export const emailProviderFactory: EmailProviderFactory | null;
}

declare module 'virtual:talisman-cms/native-schemas' {
  export const nativeSchemas: Record<string, any>;
  export const nativeSchemaConfig: Record<string, { idColumn: string }>;
}

declare module 'virtual:talisman-cms/collection-hooks' {
  import type { CollectionHooks } from './types';
  export const collectionHooks: Record<string, CollectionHooks>;
}

/** Server only: the job of every plugin that declares `scheduled`, in registration order. */
declare module 'virtual:talisman-cms/scheduled' {
  import type { ScheduledJob } from './worker';
  export const scheduledJobs: Array<{ plugin: string; job: ScheduledJob }>;
}

declare module 'virtual:talisman-cms/block-renderers' {
  export const blockRenderers: Record<string, any>;
  export const blockRenderersMeta: Record<string, { plugin: string; library: string }>;
}

declare module 'virtual:talisman-cms/component-renderers' {
  export const componentRenderers: Record<string, any>;
  export const componentRenderersMeta: Record<string, { plugin: string; library: string }>;
}

declare module 'virtual:talisman-cms/ui-libraries' {
  import type { UiLibraryDefinition } from './types';
  export const uiLibraries: UiLibraryDefinition[];
}
