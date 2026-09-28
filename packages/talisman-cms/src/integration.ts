import type { AstroIntegration } from 'astro';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import type { TalismanAuthAdapter } from './auth/types';
import { buildEmailVirtualModule } from './email/index';
import type { EmailRuntimeDescriptor } from './email/types';
import { registerAuthAdapter } from './runtime-config';
import { looksLikeSecretValue } from './env';
import { assembleMigrations, type MigrationSource } from './migrations';
import type {
  CollectionConfig,
  ComponentDefinition,
  GlobalConfig,
  Plugin,
  UiLibraryBlockAdapter,
  UiLibraryComponentAdapter,
  RuntimeCollectionHooks,
} from './types';
import { getPluginUiLibraryMetadata, resolveFieldDefinitions } from './types';

// Export types for plugin developers
export type {
  AdminEditorPanelDefinition,
  AdminEntryDescriberDefinition,
  AdminSection,
  AdminSectionDefinition,
  BlockDefinition,
  CollectionConfig,
  CollectionHookArgs,
  CollectionHooks,
  ComponentDefinition,
  ComponentSlotDefinition,
  FieldDefinition,
  FieldType,
  GlobalConfig,
  Plugin,
  RuntimeCollectionHooks,
  UiComponentPresetDefinition,
  UiLibraryBlockAdapter,
  UiLibraryComponentAdapter,
  UiLibraryDefinition,
} from './types';
export type { TalismanAuthAdapter } from './auth/types';
export type { Actor } from './service/actor';
export type { EmailRuntimeDescriptor } from './email/types';

export interface TalismanCmsOptions {
  /**
   * The base path where the CMS admin dashboard will be served.
   * @default '/admin'
   */
  adminPath?: string;
  
  /**
   * The authentication provider used to protect the CMS routes.
   * Required for production.
   */
  auth?: TalismanAuthAdapter;

  /**
   * Schemas defining the data collections managed by Talisman CMS.
   */
  collections?: CollectionConfig[];

  /**
   * Schemas defining singleton global documents managed by Talisman CMS.
   */
  globals?: GlobalConfig[];

  /**
   * Plugins to extend Talisman CMS functionality
   */
  plugins?: Plugin[];

  /**
   * A custom email provider, loaded in the Worker from `customEmail({ moduleId, exportName, args })`
   * (`talisman-cms/email`). It is used when `TALISMAN_EMAIL_PROVIDER` is unset or `custom`.
   * Without it, email goes through the `[[send_email]]` binding named `EMAIL`.
   */
  email?: EmailRuntimeDescriptor;

  /**
   * The folder, relative to the project root, into which the core's and every plugin's D1 migrations
   * are copied on each config setup. Point the `DB` binding's `migrations_dir` at it.
   * @default 'node_modules/.talisman-cms/migrations'
   */
  migrationsDir?: string;

  /**
   * Optional Cloudflare Workflow binding used for publish/archive transitions.
   */
  publishing?: {
    /**
     * Workflow binding available on the Worker environment.
     * @default 'TALISMAN_PUBLISH_WORKFLOW'
     */
    workflowBinding?: string;
  };
}

function normalizeAdminPath(adminPath?: string) {
  const trimmed = adminPath?.trim();
  if (!trimmed) return '/admin';
  if (trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function buildAuthVirtualModule(
  authAdapter: TalismanAuthAdapter | null | undefined,
  authAdapterKey: string,
  runtimeConfigPath: string,
) {
  const runtimeDescriptor = authAdapter?.__talismanAuthRuntime;

  if (runtimeDescriptor?.moduleId && runtimeDescriptor.exportName) {
    const importName = '__talismanCmsRuntimeAuthAdapter';
    const authExpression = runtimeDescriptor.type === 'value'
      ? importName
      : `${importName}(...${JSON.stringify(runtimeDescriptor.args || [])})`;

    return `
      import { ${runtimeDescriptor.exportName} as ${importName} } from ${JSON.stringify(runtimeDescriptor.moduleId)};
      export const authConfigured = ${JSON.stringify(Boolean(authAdapter))};
      export const authAdapter = ${authExpression};
    `;
  }

  return `
    import { getRegisteredAuthAdapter } from ${JSON.stringify(runtimeConfigPath)};
    export const authConfigured = ${JSON.stringify(Boolean(authAdapter))};
    export const authAdapter = getRegisteredAuthAdapter(${JSON.stringify(authAdapterKey)});
  `;
}

const DEV_AUTH_MODULE_ID = 'talisman-cms/auth/dev';
const LOOPBACK_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** DevAuthAdapter signs every request in as an admin, so it may only back a dev server bound to loopback. */
function assertDevAuthAllowed(authAdapter: TalismanAuthAdapter | undefined, command: string | undefined, serverHost: unknown) {
  if (authAdapter?.__talismanAuthRuntime?.moduleId !== DEV_AUTH_MODULE_ID) return;
  if (command === 'build' || command === 'preview') {
    throw new Error(`[talisman-cms] DevAuthAdapter signs every request in as an admin and only runs under \`astro dev\`. Configure LocalAuthAdapter, HybridAuthAdapter or AccessAuthAdapter for \`astro ${command}\`.`);
  }
  if (command === 'dev' && serverHost !== undefined && serverHost !== false &&
      !(typeof serverHost === 'string' && LOOPBACK_DEV_HOSTS.has(serverHost))) {
    throw new Error('[talisman-cms] DevAuthAdapter signs every request in as an admin, so the dev server must listen on loopback only. Remove --host (server.host) or configure LocalAuthAdapter.');
  }
}

/** Astro's `routePattern` for an injected route: the pattern without empty or trailing segments. */
function routePatternKey(pattern: string) {
  return `/${pattern.split('/').filter(Boolean).join('/')}`;
}

type ProtectedRouteKind = 'endpoint' | 'page';

/**
 * Plugin endpoints (all of which live under the admin path unless marked `public`) and plugin pages under
 * the admin path require a CMS session. The route guard middleware checks the matched route pattern.
 */
function collectProtectedPluginRoutes(plugins: Plugin[], adminPath: string, adminPathPrefix: string) {
  const routes: Record<string, ProtectedRouteKind> = {};
  for (const plugin of plugins) {
    for (const endpoint of plugin.endpoints || []) {
      if (endpoint.public) continue;
      routes[routePatternKey(`${adminPathPrefix}/api/${endpoint.path.replace(/^\//, '')}`)] = 'endpoint';
    }
    for (const route of plugin.routes || []) {
      const key = routePatternKey(route.path);
      const underAdminPath = adminPath === '/' || key === adminPath || key.startsWith(`${adminPath}/`);
      if (!underAdminPath || route.public === true) continue;
      if (route.prerender) {
        throw new Error(`[talisman-cms] ${plugin.name}: ${route.path} is under the admin path, so it needs a CMS session and cannot be prerendered. Set prerender: false, or public: true if anyone may see it.`);
      }
      if (routes[key] !== 'endpoint') routes[key] = 'page';
    }
  }
  return routes;
}

// The SPA's own top-level routes; a plugin section cannot take one of them.
const RESERVED_ADMIN_SECTION_IDS = new Set(['collections', 'globals', 'media', 'users', 'account', 'extensions', 'api']);
const ADMIN_SECTION_ID = /^[a-z][a-z0-9-]*$/;
const ADMIN_SETTING_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRET_LOOKING_SETTING = /SECRET|KEY|TOKEN|PASSWORD/;
const EDITOR_PANEL_PLACEMENTS = new Set(['before-fields', 'after-form']);

/**
 * Checks the admin extension points a plugin declares at config time, so a typo fails the build with
 * the plugin's name instead of a broken admin.
 */
function validateAdminExtensions(plugins: Plugin[]) {
  const sectionOwners = new Map<string, string>();
  for (const plugin of plugins) {
    const fail = (message: string) => {
      throw new Error(`[talisman-cms] ${plugin.name}: ${message}`);
    };
    for (const section of plugin.adminSections || []) {
      if (typeof section?.id !== 'string' || !ADMIN_SECTION_ID.test(section.id)) {
        fail(`adminSections ids are lowercase slugs (letters, digits and hyphens), not ${JSON.stringify(section?.id)}.`);
      }
      if (RESERVED_ADMIN_SECTION_IDS.has(section.id)) fail(`the admin section id "${section.id}" is a built-in admin route.`);
      const owner = sectionOwners.get(section.id);
      if (owner) fail(`the admin section "${section.id}" is already registered by ${owner}.`);
      sectionOwners.set(section.id, plugin.name);
      if (typeof section.label !== 'string' || !section.label.trim()) fail(`the admin section "${section.id}" needs a label.`);
      if (section.componentPath !== undefined && (typeof section.componentPath !== 'string' || !section.componentPath.trim())) {
        fail(`the admin section "${section.id}" has an empty componentPath.`);
      }
    }
    for (const panel of plugin.adminEditorPanels || []) {
      if (typeof panel?.id !== 'string' || !panel.id.trim()) fail('every adminEditorPanels entry needs an id.');
      if (typeof panel.componentPath !== 'string' || !panel.componentPath.trim()) fail(`the editor panel "${panel.id}" needs a componentPath.`);
      if (!EDITOR_PANEL_PLACEMENTS.has(panel.placement)) {
        fail(`the editor panel "${panel.id}" has placement ${JSON.stringify(panel.placement)}; use before-fields or after-form.`);
      }
      for (const [key, list] of [['sections', panel.sections], ['slugs', panel.slugs]] as const) {
        if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item))) {
          fail(`the editor panel "${panel.id}" has a ${key} list that is not a list of names.`);
        }
      }
    }
    for (const describer of plugin.adminEntryDescribers || []) {
      if (typeof describer?.modulePath !== 'string' || !describer.modulePath.trim()) fail('every adminEntryDescribers entry needs a modulePath.');
    }
    for (const name of plugin.adminSettings || []) {
      if (typeof name !== 'string' || !ADMIN_SETTING_NAME.test(name)) {
        fail(`adminSettings names are TALISMAN_* setting names without the prefix, in upper case, not ${JSON.stringify(name)}.`);
      }
      if (SECRET_LOOKING_SETTING.test(name) || SECRET_LOOKING_KEY.test(name)) fail(`the setting ${name} looks like a secret and cannot be exposed to the admin page.`);
    }
    for (const dir of plugin.adminStyleSources || []) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) fail(`adminStyleSources entries are absolute directories, not ${JSON.stringify(dir)}.`);
      let isDirectory = false;
      try {
        isDirectory = statSync(dir).isDirectory();
      } catch {
        // Reported below.
      }
      if (!isDirectory) fail(`the adminStyleSources directory ${dir} does not exist.`);
    }
  }
}

const SECRET_LOOKING_KEY = /secret|token|passw(?:or)?d|api[-_]?key|private[-_]?key|credential/i;

/** Drop secret-looking keys and values from data bound for the browser, reporting each path once. */
function withoutSecretLookingValues(value: unknown, path: string, dropped: string[]): unknown {
  if (typeof value === 'string') {
    if (!looksLikeSecretValue(value)) return value;
    dropped.push(path);
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item, index) => withoutSecretLookingValues(item, `${path}[${index}]`, dropped));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_LOOKING_KEY.test(key)) {
      dropped.push(`${path}.${key}`);
      continue;
    }
    result[key] = withoutSecretLookingValues(item, `${path}.${key}`, dropped);
  }
  return result;
}

/**
 * The admin SPA imports virtual:talisman-cms/config in the browser, and its bundle is a public static asset.
 * The client copy keeps only what the admin navigation and globals editor read: never runtimeHooks (whose
 * factory args are server configuration), publishing bindings, or anything that looks like a secret.
 */
function buildClientConfigModule(options: TalismanCmsOptions, adminPath: string) {
  const collections = (options.collections || []).map((collection) => ({
    name: collection.name,
    slug: collection.slug,
    description: collection.description,
    fields: collection.fields,
    adminSection: collection.adminSection,
    readOnly: collection.readOnly,
    access: collection.access,
    nativeSchemaMapping: collection.nativeSchemaMapping && {
      schemaPath: collection.nativeSchemaMapping.schemaPath,
      exportName: collection.nativeSchemaMapping.exportName,
      idColumn: collection.nativeSchemaMapping.idColumn,
    },
  }));
  const globals = (options.globals || []).map((globalConfig) => ({
    name: globalConfig.name,
    slug: globalConfig.slug,
    description: globalConfig.description,
    fields: globalConfig.fields,
  }));
  const adminLinks = (options.plugins || []).flatMap((plugin) => plugin.adminLinks || [])
    .map(({ section, label, description, href }) => ({ section, label, description, href }));
  const adminSections = registeredAdminSectionIds(options.plugins || []);
  const dropped: string[] = [];
  const safe = withoutSecretLookingValues({
    collections,
    globals,
    adminLinks,
    uiLibraries: getPluginUiLibraryMetadata(options.plugins || []),
  }, 'config', dropped) as Record<string, unknown>;
  if (dropped.length) {
    console.warn(`[talisman-cms] Left out of the public admin bundle because they look like secrets: ${dropped.join(', ')}. Read secrets from Worker env bindings at request time.`);
  }
  return `
    export const adminPath = ${JSON.stringify(adminPath)};
    export const collections = ${JSON.stringify(safe.collections)};
    export const adminLinks = ${JSON.stringify(safe.adminLinks)};
    export const adminSections = ${JSON.stringify(adminSections)};
    export const globals = ${JSON.stringify(safe.globals)};
    export const uiLibraries = ${JSON.stringify(safe.uiLibraries)};
  `;
}

/** The ids of the admin sections plugins registered, in registration order. */
function registeredAdminSectionIds(plugins: Plugin[]) {
  return plugins.flatMap((plugin) => (plugin.adminSections || []).map((section) => section.id));
}

function buildServerConfigModule(options: TalismanCmsOptions, adminPath: string) {
  return `
    export const adminPath = ${JSON.stringify(adminPath)};
    export const collections = ${JSON.stringify(options.collections || [])};
    export const adminLinks = ${JSON.stringify((options.plugins || []).flatMap(plugin => plugin.adminLinks || []))};
    export const adminSections = ${JSON.stringify(registeredAdminSectionIds(options.plugins || []))};
    export const globals = ${JSON.stringify(options.globals || [])};
    export const uiLibraries = ${JSON.stringify(getPluginUiLibraryMetadata(options.plugins || []))};
    export const adminSettings = ${JSON.stringify([...new Set((options.plugins || []).flatMap((plugin) => plugin.adminSettings || []))])};
    export const publishing = ${JSON.stringify({
      workflowBinding: options.publishing?.workflowBinding || 'TALISMAN_PUBLISH_WORKFLOW'
    })};
  `;
}

/**
 * The admin SPA's registry of plugin screens: extension pages, sections, editor panels and record
 * describers. Page and panel components are lazy imports, so each loads when first shown; describer
 * modules are small and imported statically, as every relation label may need them.
 */
function buildAdminExtensionsModule(plugins: Plugin[]) {
  const extensions = plugins.flatMap((plugin) => (plugin.adminUi || []).map((ext) => `{
    path: ${JSON.stringify(ext.path)},
    label: ${JSON.stringify(ext.label)},
    section: ${JSON.stringify(ext.section || null)},
    plugin: ${JSON.stringify(plugin.name)},
    component: lazy(() => import(${JSON.stringify(ext.componentPath)}))
  }`));
  const sections = plugins.flatMap((plugin) => (plugin.adminSections || []).map((section) => `{
    id: ${JSON.stringify(section.id)},
    label: ${JSON.stringify(section.label)},
    description: ${JSON.stringify(section.description ?? null)},
    icon: ${JSON.stringify(section.icon ?? null)},
    adminOnly: ${JSON.stringify(section.adminOnly === true)},
    emptyState: ${JSON.stringify(section.emptyState ?? null)},
    plugin: ${JSON.stringify(plugin.name)},
    workspace: ${section.componentPath ? `lazy(() => import(${JSON.stringify(section.componentPath)}))` : 'null'}
  }`));
  const panels = plugins.flatMap((plugin) => (plugin.adminEditorPanels || []).map((panel) => `{
    id: ${JSON.stringify(panel.id)},
    placement: ${JSON.stringify(panel.placement)},
    sections: ${JSON.stringify(panel.sections ?? null)},
    slugs: ${JSON.stringify(panel.slugs ?? null)},
    plugin: ${JSON.stringify(plugin.name)},
    component: lazy(() => import(${JSON.stringify(panel.componentPath)}))
  }`));
  const describerImports: string[] = [];
  const describers = plugins.flatMap((plugin) => (plugin.adminEntryDescribers || []).map((describer) => {
    const importName = `describer_${describerImports.length}`;
    describerImports.push(`import * as ${importName} from ${JSON.stringify(describer.modulePath)};`);
    return `{ plugin: ${JSON.stringify(plugin.name)}, module: ${importName} }`;
  }));

  return `
    import { lazy } from 'react';
    ${describerImports.join('\n')}

    export const adminExtensions = [
      ${extensions.join(',\n')}
    ];
    export const adminSections = [
      ${sections.join(',\n')}
    ];
    export const adminEditorPanels = [
      ${panels.join(',\n')}
    ];
    export const adminEntryDescribers = [
      ${describers.join(',\n')}
    ];
  `;
}

function ensureSystemCollections(collections: CollectionConfig[]) {
  if (!collections.some((collection) => collection.slug === 'media')) {
    collections.push({
      name: 'Media',
      slug: 'media',
      description: 'Global asset library for the CMS.',
      fields: [
        { name: 'id', label: 'ID', type: 'text', required: true },
        { name: 'filename', label: 'File Name', type: 'text', required: true },
        { name: 'url', label: 'URL', type: 'text', required: true },
        { name: 'mimeType', label: 'MIME Type', type: 'text', required: true },
        { name: 'sizeBytes', label: 'Size (Bytes)', type: 'number', required: true },
        { name: 'altText', label: 'Alt Text', type: 'text' },
        { name: 'width', label: 'Width (px)', type: 'number' },
        { name: 'height', label: 'Height (px)', type: 'number' }
      ],
      nativeSchemaMapping: {
        schemaPath: 'talisman-cms/db/media',
        exportName: 'media',
        idColumn: 'id'
      }
    });
  }

  if (!collections.some((collection) => collection.slug === '_ui_component_presets')) {
    collections.push({
      name: 'Component Presets',
      slug: '_ui_component_presets',
      description: 'Reusable component presets for page-builder component slots.',
      fields: [
        { name: 'name', label: 'Preset Name', type: 'text', required: true },
        { name: 'libraryId', label: 'Library ID', type: 'text', required: true },
        { name: 'componentSlug', label: 'Component Slug', type: 'text', required: true },
        { name: 'variant', label: 'Variant', type: 'text' },
        { name: 'propsJson', label: 'Serialized Props (JSON)', type: 'textarea', required: true, defaultValue: '{}' }
      ]
    });
  }

  return collections;
}

function collectBlockRendererAdapters(plugins: Plugin[] = []) {
  return plugins.flatMap((plugin) =>
    (plugin.uiLibraries || []).flatMap((library) =>
      (library.blocks || []).flatMap((adapter) =>
        adapter.renderer
          ? [{
              slug: adapter.block.slug,
              modulePath: adapter.renderer.modulePath,
              exportName: adapter.renderer.exportName,
              plugin: plugin.name,
              library: library.id,
            }]
          : []
      )
    )
  );
}

function collectComponentRendererAdapters(plugins: Plugin[] = []) {
  return plugins.flatMap((plugin) =>
    (plugin.uiLibraries || []).flatMap((library) =>
      (library.components || []).flatMap((adapter) => {
        const renderer = adapter.renderer || adapter.component.advanced?.renderer;
        return renderer
          ? [{
              slug: adapter.component.slug,
              modulePath: renderer.modulePath,
              exportName: renderer.exportName,
              plugin: plugin.name,
              library: library.id,
            }]
          : []
      })
    )
  );
}

function buildRendererVirtualModule(
  entries: Array<{ slug: string; modulePath: string; exportName?: string; plugin: string; library: string }>,
  exportName: string,
) {
  const imports: string[] = [];
  const mappings: string[] = [];
  const meta: string[] = [];

  entries.forEach((entry, index) => {
    const importName = `${exportName}_${index}`;
    if (entry.exportName) {
      imports.push(`import { ${entry.exportName} as ${importName} } from ${JSON.stringify(entry.modulePath)};`);
    } else {
      imports.push(`import ${importName} from ${JSON.stringify(entry.modulePath)};`);
    }

    mappings.push(`${JSON.stringify(entry.slug)}: ${importName}`);
    meta.push(`${JSON.stringify(entry.slug)}: ${JSON.stringify({ plugin: entry.plugin, library: entry.library })}`);
  });

  return `
    ${imports.join('\n')}
    export const ${exportName} = {
      ${mappings.join(',\n')}
    };
    export const ${exportName}Meta = {
      ${meta.join(',\n')}
    };
  `;
}

function buildCollectionHooksVirtualModule(collections: CollectionConfig[]) {
  const imports: string[] = [];
  const entries: string[] = [];

  collections.forEach((collection, collectionIndex) => {
    const hookSets = (collection.runtimeHooks || []).map((descriptor: RuntimeCollectionHooks, hookIndex) => {
      const importName = `hooks_${collectionIndex}_${hookIndex}`;
      imports.push(`import { ${descriptor.exportName} as ${importName} } from ${JSON.stringify(descriptor.moduleId)};`);
      return descriptor.factory
        ? `${importName}(${JSON.stringify(descriptor.args ?? null)})`
        : importName;
    });
    if (hookSets.length) {
      entries.push(`${JSON.stringify(collection.slug)}: mergeHooks([${hookSets.join(', ')}])`);
    }
  });

  return `
    ${imports.join('\n')}
    const hookNames = ['beforeValidate', 'beforeChange', 'afterChange', 'beforeDelete', 'afterDelete'];
    function mergeHooks(sets) {
      const result = {};
      for (const hooks of sets) {
        for (const name of hookNames) {
          if (hooks?.[name]) result[name] = [...(result[name] || []), ...hooks[name]];
        }
      }
      return result;
    }
    export const collectionHooks = { ${entries.join(',\n')} };
  `;
}

const DEFAULT_MIGRATIONS_DIR = 'node_modules/.talisman-cms/migrations';
const WRANGLER_CONFIG_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];
// Resolves from dist/ and from src/ alike.
const coreMigrationsDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

function samePath(a: string, b: string) {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  return real(a) === real(b);
}

/**
 * Best-effort reading of the site's wrangler config, without a TOML parser: every `migrations_dir`
 * value outside comments. A D1 binding still pointed at the core package's own `drizzle` folder would
 * miss the plugins' migrations, so that stops the build once a plugin ships any; a config in which no
 * binding points at the assembled folder gets a warning.
 */
function checkWranglerMigrationsDir(projectRoot: string, outDir: string, displayDir: string, pluginsShipMigrations: boolean) {
  const found: string[] = [];
  let pointsAtAssembled = false;
  for (const fileName of WRANGLER_CONFIG_FILES) {
    const configPath = join(projectRoot, fileName);
    if (!existsSync(configPath)) continue;
    const isToml = fileName.endsWith('.toml');
    const raw = readFileSync(configPath, 'utf8');
    const text = isToml ? raw.replace(/^\s*#.*$/gm, '') : raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of text.matchAll(/["']?migrations_dir["']?\s*[=:]\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = match[1] ?? match[2] ?? '';
      const dir = resolve(projectRoot, value);
      if (samePath(dir, outDir)) {
        pointsAtAssembled = true;
      } else if (pluginsShipMigrations && samePath(dir, coreMigrationsDir)) {
        const line = isToml ? `migrations_dir = "${displayDir}"` : `"migrations_dir": "${displayDir}"`;
        throw new Error(`[talisman-cms] ${fileName}: migrations_dir = "${value}" is the core package's own migrations folder, which no longer holds every migration: plugins ship theirs too. Point the D1 binding at the assembled folder, ${line}, and run \`astro sync\` or a build before \`wrangler d1 migrations apply\`.`);
      }
      found.push(`${fileName}: migrations_dir = "${value}"`);
    }
  }
  if (found.length && !pointsAtAssembled) {
    console.warn(`[talisman-cms] No D1 binding's migrations_dir points at the assembled migrations folder (${displayDir}); found ${found.join(', ')}. Migrations of the core and its plugins are applied from that folder.`);
  }
}

/**
 * Wrangler applies the `.sql` files of one folder per D1 binding, so the core's migrations and every
 * plugin's are copied into one folder in the project on each config setup: `astro dev`, `build`,
 * `sync` and `check` all run it before the site's `wrangler d1 migrations apply`.
 */
function writeProjectMigrations(options: TalismanCmsOptions, plugins: Plugin[], projectRoot: string) {
  const sources: MigrationSource[] = [
    { name: 'talisman-cms', dir: coreMigrationsDir },
    ...plugins.flatMap((plugin) => (plugin.migrations?.dir ? [{ name: plugin.name, dir: plugin.migrations.dir }] : [])),
  ];
  const configured = options.migrationsDir?.trim() || DEFAULT_MIGRATIONS_DIR;
  const outDir = resolve(projectRoot, configured);
  const displayDir = isAbsolute(configured) ? relative(projectRoot, outDir) : configured;
  checkWranglerMigrationsDir(projectRoot, outDir, displayDir, sources.length > 1);
  const files = assembleMigrations({ sources, outDir });
  const counts = sources.map((source) => `${source.name} ${files.filter((file) => file.source === source.name).length}`);
  console.log(`[talisman-cms] Wrote ${files.length} migrations to ${displayDir} (${counts.join(', ')})`);
}

export default function talismanCms(options?: TalismanCmsOptions): AstroIntegration {
  // Apply plugins to modify config
  let finalOptions = { ...options };
  if (options?.plugins) {
    for (const plugin of options.plugins) {
      if (plugin.onInit) {
        finalOptions = plugin.onInit(finalOptions);
      }
    }
  }

  finalOptions.plugins = finalOptions.plugins || [];
  if (finalOptions.auth && !finalOptions.auth.__talismanAuthRuntime) {
    throw new Error('[talisman-cms] Auth adapters must provide __talismanAuthRuntime so the Worker can load them.');
  }
  // Built now so an invalid email descriptor fails the config instead of the Worker.
  const emailVirtualModule = buildEmailVirtualModule(finalOptions.email);
  finalOptions.collections = ensureSystemCollections(finalOptions.collections || []);
  for (const collection of finalOptions.collections) {
    if ('hooks' in collection && collection.hooks) {
      throw new Error(`[talisman-cms] ${collection.slug}: inline hooks cannot survive the server build. Move them to runtimeHooks modules.`);
    }
  }

  if (finalOptions.collections) {
    finalOptions.collections = finalOptions.collections.map((collection) => ({
      ...collection,
      fields: resolveFieldDefinitions(collection.fields || [], finalOptions.plugins || [])
    }));
  }

  if (finalOptions.globals) {
    finalOptions.globals = finalOptions.globals.map((globalConfig) => ({
      ...globalConfig,
      fields: resolveFieldDefinitions(globalConfig.fields || [], finalOptions.plugins || [])
    }));
  }

  const adminPath = normalizeAdminPath(finalOptions?.adminPath);
  const adminPathPrefix = adminPath === '/' ? '' : adminPath;
  const protectedPluginRoutes = collectProtectedPluginRoutes(finalOptions.plugins, adminPath, adminPathPrefix);
  validateAdminExtensions(finalOptions.plugins);

  // Astro compiles injected .astro and .ts routes from package source.
  const adminRoutePath = fileURLToPath(new URL('../src/routes/admin.astro', import.meta.url));
  const apiRoutePath = fileURLToPath(new URL('../src/routes/api.ts', import.meta.url));
  const apiAuthSessionRoutePath = fileURLToPath(new URL('../src/routes/api/auth/session.ts', import.meta.url));
  const apiAuthLocalRoutePath = fileURLToPath(new URL('../src/routes/api/auth/local.ts', import.meta.url));
  const apiAuthSetupRoutePath = fileURLToPath(new URL('../src/routes/api/auth/setup.ts', import.meta.url));
  const apiAuthSsoRoutePath = fileURLToPath(new URL('../src/routes/api/auth/sso.ts', import.meta.url));
  const pluginRouteGuardPath = fileURLToPath(new URL('../src/routes/plugin-route-guard.ts', import.meta.url));

  let runtimeConfigPath = fileURLToPath(new URL('./runtime-config.js', import.meta.url));
  if (!existsSync(runtimeConfigPath)) {
    runtimeConfigPath = fileURLToPath(new URL('../src/runtime-config.ts', import.meta.url));
  }

  const authAdapterKey = `talisman-cms:${adminPath}`;
  registerAuthAdapter(authAdapterKey, finalOptions?.auth ?? null);

  return {
    name: 'talisman-cms',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig, addDevToolbarApp, addMiddleware, command, config }) => {
        assertDevAuthAllowed(finalOptions.auth, command, config?.server?.host);
        // Astro always passes config.root; the stand-ins in unit tests do not, and then there is no project to write into.
        if (config?.root) writeProjectMigrations(finalOptions, finalOptions.plugins || [], fileURLToPath(config.root));

        console.log('[talisman-cms] Injecting admin route from:', adminRoutePath);

        // 0. Register the Astro Dev Toolbar App
        let toolbarAppPath = fileURLToPath(new URL('./toolbar/app.js', import.meta.url));
        if (!existsSync(toolbarAppPath)) {
          toolbarAppPath = fileURLToPath(new URL('../src/toolbar/app.ts', import.meta.url));
        }

        if (addDevToolbarApp) {
          addDevToolbarApp({
            id: 'talisman-cms',
            name: 'Talisman CMS',
            icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#818cf8" stroke-width="2"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" stroke="#c084fc" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="#6366f1"/></svg>`,
            entrypoint: toolbarAppPath
          });
        }

        // 1. Inject the catch-all route for the React Admin SPA
        injectRoute({
          pattern: `${adminPathPrefix}/[...route]`,
          entrypoint: adminRoutePath,
          prerender: false // Ensure it runs on the server (Cloudflare Worker)
        });

        // 2. Inject the base route for the React Admin SPA
        injectRoute({
          pattern: adminPath,
          entrypoint: adminRoutePath,
          prerender: false
        });

        // 3. Inject the Backend API wildcard route
        injectRoute({
          pattern: `${adminPathPrefix}/api/[...route]`,
          entrypoint: apiRoutePath,
          prerender: false
        });
        
        // 3.5. Inject Auth Session Route BEFORE wildcard
        injectRoute({
          pattern: `${adminPathPrefix}/api/auth/session`,
          entrypoint: apiAuthSessionRoutePath,
          prerender: false
        });

        injectRoute({
          pattern: `${adminPathPrefix}/api/auth/setup`,
          entrypoint: apiAuthSetupRoutePath,
          prerender: false
        });

        injectRoute({
          pattern: `${adminPathPrefix}/sso`,
          entrypoint: apiAuthSsoRoutePath,
          prerender: false
        });

        injectRoute({
          pattern: `${adminPathPrefix}/api/auth/[...route]`,
          entrypoint: apiAuthLocalRoutePath,
          prerender: false
        });

        // 3.6. Inject Media Upload Route BEFORE wildcard
        const apiMediaUploadRoutePath = fileURLToPath(new URL('../src/routes/api/media-upload.ts', import.meta.url));

        injectRoute({
          pattern: `${adminPathPrefix}/api/media/upload`,
          entrypoint: apiMediaUploadRoutePath,
          prerender: false
        });

        // 3.7. Inject Media Serve Route BEFORE wildcard
        const apiMediaServeRoutePath = fileURLToPath(new URL('../src/routes/api/media-serve.ts', import.meta.url));

        injectRoute({
          pattern: '/api/media/[...route]',
          entrypoint: apiMediaServeRoutePath,
          prerender: false
        });

        // 3.8. Inject Plugin API Endpoints BEFORE wildcard. Those without `public: true`, and plugin pages
        // under the admin path, pass through the route guard, which requires a CMS session.
        if (Object.keys(protectedPluginRoutes).length > 0) {
          addMiddleware({ order: 'post', entrypoint: pluginRouteGuardPath });
        }
        if (finalOptions?.plugins) {
          for (const plugin of finalOptions.plugins) {
            if (plugin.endpoints) {
              for (const endpoint of plugin.endpoints) {
                 const pattern = `${endpoint.public ? '' : adminPathPrefix}/api/${endpoint.path.replace(/^\//, '')}`;
                 console.log(`[talisman-cms] Injecting plugin route: ${pattern} -> ${endpoint.entrypoint}`);
                 injectRoute({
                   pattern,
                   entrypoint: endpoint.entrypoint,
                   prerender: false
                 });
              }
            }
            if (plugin.routes) {
              for (const route of plugin.routes) {
                 console.log(`[talisman-cms] Injecting plugin page: ${route.path} -> ${route.entrypoint}`);
                 injectRoute({
                   pattern: route.path,
                   entrypoint: route.entrypoint,
                   prerender: !!route.prerender
                 });
              }
            }
          }
        }

        // 3.9 Extract user plugin vite configurations
        let userVitePlugins: any[] = [];
        if (finalOptions?.plugins) {
          for (const plugin of finalOptions.plugins) {
            if (plugin.vite?.plugins) {
              userVitePlugins = [...userVitePlugins, ...plugin.vite.plugins];
            }
          }
        }

        // 3.10 Plugin admin screens that use Tailwind classes: Tailwind only scans the folders the admin
        // stylesheet names, so each plugin folder is added to it as an @source line when it loads.
        const adminStylesheetPath = fileURLToPath(new URL('../ui/globals.css', import.meta.url));
        const adminStyleSources = [...new Set((finalOptions.plugins || []).flatMap((plugin) => plugin.adminStyleSources || []))];

        // 4. Inject vite config to handle the React SPA within the package
        updateConfig({
          vite: {
            resolve: {
              // Linked plugins can have their own React installation in a workspace.
              // Hooks must use the same instance as the CMS admin renderer, and
              // react-dom must match the app's react version (React error #527).
              dedupe: ['react', 'react-dom', '@tanstack/react-router'],
            },
            plugins: [
              ...userVitePlugins,
              tailwindcss() as any,
              TanStackRouterVite({
                routesDirectory: fileURLToPath(new URL('../ui/routes', import.meta.url)),
                generatedRouteTree: fileURLToPath(new URL('../ui/routeTree.gen.ts', import.meta.url)),
                // Each route's component becomes its own chunk, loaded when the route is first opened.
                autoCodeSplitting: true,
              }),
              {
                name: 'vite-plugin-talisman-cms-auth',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/auth') return '\0virtual:talisman-cms/auth';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/auth') {
                    return buildAuthVirtualModule(finalOptions?.auth, authAdapterKey, runtimeConfigPath);
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-email',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/email') return '\0virtual:talisman-cms/email';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/email') return emailVirtualModule;
                }
              },
              {
                name: 'vite-plugin-talisman-cms-config',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/config') return '\0virtual:talisman-cms/config';
                },
                load(id, loadOptions) {
                  if (id === '\0virtual:talisman-cms/config') {
                    // The admin SPA bundle is public, so the browser build gets a client-safe projection.
                    const environment = (this as { environment?: { config: { consumer: string } } } | undefined)?.environment;
                    const forBrowser = environment ? environment.config.consumer === 'client' : !loadOptions?.ssr;
                    return forBrowser
                      ? buildClientConfigModule(finalOptions, adminPath)
                      : buildServerConfigModule(finalOptions, adminPath);
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-protected-routes',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/protected-routes') return '\0virtual:talisman-cms/protected-routes';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/protected-routes') {
                    return `
                      export const adminPath = ${JSON.stringify(adminPath)};
                      export const protectedRoutes = ${JSON.stringify(protectedPluginRoutes)};
                    `;
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-collection-hooks',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/collection-hooks') return '\0virtual:talisman-cms/collection-hooks';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/collection-hooks') {
                    return buildCollectionHooksVirtualModule(finalOptions.collections || []);
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-schemas',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/native-schemas') return '\0virtual:talisman-cms/native-schemas';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/native-schemas') {
                    const imports: string[] = [];
                    const exports: string[] = [];
                    
                    (finalOptions?.collections || []).forEach((c, index) => {
                      if (c.nativeSchemaMapping) {
                        const importName = `native_schema_${index}`;
                        const resolvedPath = c.nativeSchemaMapping.schemaPath;
                        imports.push(`import { ${c.nativeSchemaMapping.exportName} as ${importName} } from '${resolvedPath}';`);
                        exports.push(`'${c.slug}': ${importName}`);
                      }
                    });

                    return `
                      ${imports.join('\n')}
                      export const nativeSchemas = {
                        ${exports.join(',\n')}
                      };
                      export const nativeSchemaConfig = ${JSON.stringify(
                        Object.fromEntries(
                          (finalOptions?.collections || [])
                            .filter(c => c.nativeSchemaMapping)
                            .map(c => [
                              c.slug,
                              { idColumn: c.nativeSchemaMapping?.idColumn || 'id' }
                            ])
                        )
                      )};
                    `;
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-block-renderers',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/block-renderers') return '\0virtual:talisman-cms/block-renderers';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/block-renderers') {
                    return buildRendererVirtualModule(collectBlockRendererAdapters(finalOptions?.plugins || []), 'blockRenderers');
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-component-renderers',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/component-renderers') return '\0virtual:talisman-cms/component-renderers';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/component-renderers') {
                    return buildRendererVirtualModule(collectComponentRendererAdapters(finalOptions?.plugins || []), 'componentRenderers');
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-ui-libraries',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/ui-libraries') return '\0virtual:talisman-cms/ui-libraries';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/ui-libraries') {
                    return `
                      export const uiLibraries = ${JSON.stringify((finalOptions?.plugins || []).flatMap((plugin) => plugin.uiLibraries || []))};
                    `;
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-admin-extensions',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/admin-extensions') return '\0virtual:talisman-cms/admin-extensions';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/admin-extensions') {
                    return buildAdminExtensionsModule(finalOptions?.plugins || []);
                  }
                }
              },
              {
                name: 'vite-plugin-talisman-cms-admin-styles',
                load(id) {
                  if (adminStyleSources.length === 0 || id.split('?')[0] !== adminStylesheetPath) return;
                  const sources = adminStyleSources.map((dir) => `@source ${JSON.stringify(dir)};`).join('\n');
                  return `${readFileSync(adminStylesheetPath, 'utf8')}\n${sources}\n`;
                }
              }
            ],
            optimizeDeps: {
              // Pre-bundle the admin SPA's browser deps for `astro dev`. The SPA and plugin
              // admin pages are served from node_modules, where Vite does not discover bare
              // imports, so CommonJS deps such as react/jsx-runtime would reach the browser
              // as-is. react/react-dom are app peers; `talisman-cms > x` resolves unhoisted deps.
              include: [
                'react',
                'react/jsx-runtime',
                'react/jsx-dev-runtime',
                'react-dom',
                'react-dom/client',
                'talisman-cms > @tanstack/react-router',
                'talisman-cms > @tanstack/react-form',
                'talisman-cms > @tiptap/react',
                'talisman-cms > @tiptap/starter-kit',
                'talisman-cms > @radix-ui/react-dropdown-menu',
                'talisman-cms > @radix-ui/react-slot',
                'talisman-cms > lucide-react',
                'talisman-cms > clsx',
                'talisman-cms > tailwind-merge',
                'talisman-cms > zod'
              ],
              // Native node modules cannot be bundled by esbuild
              exclude: [
                '@tailwindcss/vite',
                'tailwindcss',
                'lightningcss',
                'fsevents',
                'virtual:talisman-cms/native-schemas',
                'virtual:talisman-cms/block-renderers',
                'virtual:talisman-cms/component-renderers',
                'virtual:talisman-cms/ui-libraries',
                'virtual:talisman-cms/admin-extensions'
              ]
            },
            ssr: {
              // Avoid externalizing the UI package during SSR so Astro can bundle it
              noExternal: ['talisman-cms']
            }
          }
        });
      }
    }
  };
}
