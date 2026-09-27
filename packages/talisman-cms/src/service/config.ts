import type { CollectionConfig, CollectionHooks, GlobalConfig, UiLibraryDefinition } from '../types';
import { DEFAULT_PUBLISHING_WORKFLOW_BINDING } from '../versioning';

/** The site's configuration as the service reads it, the same in the Worker and in Node. */
export interface ServiceConfig {
  collections: CollectionConfig[];
  globals: GlobalConfig[];
  /** The UI libraries plugins register, which component preset validation checks against. */
  uiLibraries: UiLibraryDefinition[];
  /** The Drizzle tables of the native collections, by collection slug. */
  nativeSchemas: Record<string, any>;
  /** Hooks compiled from each collection's `runtimeHooks`, by collection slug. */
  collectionHooks: Record<string, CollectionHooks>;
  /** The Workflow binding publishing runs through (`publishing.workflowBinding`). */
  publishingWorkflowBinding: string;
}

/** The virtual modules the configuration comes from; a missing one contributes nothing. */
export interface ServiceConfigModules {
  config?: { collections?: CollectionConfig[]; globals?: GlobalConfig[]; publishing?: { workflowBinding?: string } } | null;
  uiLibraries?: { uiLibraries?: UiLibraryDefinition[] } | null;
  nativeSchemas?: { nativeSchemas?: Record<string, any> } | null;
  collectionHooks?: { collectionHooks?: Record<string, CollectionHooks> } | null;
}

/**
 * The configuration from virtual modules a route module imports statically, as the admin API
 * handler does: Vite bundles them into the Worker with the site's hook modules, and a module that
 * fails to load fails the build instead of running the admin without hooks.
 */
export function configFromModules(modules: ServiceConfigModules): ServiceConfig {
  return {
    collections: modules.config?.collections ?? [],
    globals: modules.config?.globals ?? [],
    uiLibraries: modules.uiLibraries?.uiLibraries ?? [],
    nativeSchemas: modules.nativeSchemas?.nativeSchemas ?? {},
    collectionHooks: modules.collectionHooks?.collectionHooks ?? {},
    publishingWorkflowBinding: modules.config?.publishing?.workflowBinding || DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  };
}

/** A virtual module, or null where nothing provides it (Node during an Astro build, or a test). */
async function optionalModule<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

let loaded: Promise<ServiceConfig> | null = null;

/**
 * The configuration for code bundled apart from the route modules: `getClient` in `dist/client.js`
 * reaches the virtual modules through dynamic imports, which Vite resolves inside the Worker bundle
 * and which fail in Node, where the service then runs with no configured collections, globals,
 * hooks or native tables. Loaded once per module instance.
 */
export function loadServiceConfig(): Promise<ServiceConfig> {
  loaded ??= (async () => configFromModules({
    config: await optionalModule(() => import('virtual:talisman-cms/config')),
    uiLibraries: await optionalModule(() => import('virtual:talisman-cms/ui-libraries')),
    nativeSchemas: await optionalModule(() => import('virtual:talisman-cms/native-schemas')),
    collectionHooks: await optionalModule(() => import('virtual:talisman-cms/collection-hooks')),
  }))();
  return loaded;
}
