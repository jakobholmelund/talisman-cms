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
  import type { CollectionConfig, GlobalConfig, UiLibraryDefinition } from './types';
  export const adminPath: string;
  export const collections: CollectionConfig[];
  export const globals: GlobalConfig[];
  export const adminLinks: { section: 'collections' | 'commerce'; label: string; description: string; href: string }[];
  export const uiLibraries: Array<Pick<UiLibraryDefinition, 'id' | 'name' | 'requirements' | 'presets'> & {
    blockSlugs: string[];
    componentSlugs: string[];
  }>;
  /** Server only. */
  export const publishing: {
    workflowBinding: string;
  };
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
