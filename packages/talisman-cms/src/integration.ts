import type { AstroIntegration } from 'astro';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import type { TalismanAuthAdapter } from './auth/types';
import { registerAuthAdapter } from './runtime-config';
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

  // Astro compiles injected .astro and .ts routes from package source.
  const adminRoutePath = fileURLToPath(new URL('../src/routes/admin.astro', import.meta.url));
  const apiRoutePath = fileURLToPath(new URL('../src/routes/api.ts', import.meta.url));
  const apiAuthSessionRoutePath = fileURLToPath(new URL('../src/routes/api/auth/session.ts', import.meta.url));
  const apiAuthLocalRoutePath = fileURLToPath(new URL('../src/routes/api/auth/local.ts', import.meta.url));
  const apiAuthSetupRoutePath = fileURLToPath(new URL('../src/routes/api/auth/setup.ts', import.meta.url));
  const apiAuthSsoRoutePath = fileURLToPath(new URL('../src/routes/api/auth/sso.ts', import.meta.url));

  let runtimeConfigPath = fileURLToPath(new URL('./runtime-config.js', import.meta.url));
  if (!existsSync(runtimeConfigPath)) {
    runtimeConfigPath = fileURLToPath(new URL('../src/runtime-config.ts', import.meta.url));
  }

  const authAdapterKey = `talisman-cms:${adminPath}`;
  registerAuthAdapter(authAdapterKey, finalOptions?.auth ?? null);

  return {
    name: 'talisman-cms',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig, addDevToolbarApp }) => {
        
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

        // 3.8. Inject Plugin API Endpoints BEFORE wildcard
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
                name: 'vite-plugin-talisman-cms-config',
                resolveId(id) {
                  if (id === 'virtual:talisman-cms/config') return '\0virtual:talisman-cms/config';
                },
                load(id) {
                  if (id === '\0virtual:talisman-cms/config') {
                    return `
                      export const adminPath = ${JSON.stringify(adminPath)};
                      export const collections = ${JSON.stringify(finalOptions?.collections || [])};
                      export const adminLinks = ${JSON.stringify((finalOptions?.plugins || []).flatMap(plugin => plugin.adminLinks || []))};
                      export const globals = ${JSON.stringify(finalOptions?.globals || [])};
                      export const uiLibraries = ${JSON.stringify(getPluginUiLibraryMetadata(finalOptions?.plugins || []))};
                      export const publishing = ${JSON.stringify({
                        workflowBinding: finalOptions?.publishing?.workflowBinding || 'TALISMAN_PUBLISH_WORKFLOW'
                      })};
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
                    const extensions = (finalOptions?.plugins || []).flatMap((plugin) => 
                      (plugin.adminUi || []).map(ext => ({...ext, plugin: plugin.name}))
                    );
                    
                    const imports = extensions.map((ext, idx) => `import Ext_${idx} from '${ext.componentPath}';`).join('\n');
                    const configExports = extensions.map((ext, idx) => `{
                      path: ${JSON.stringify(ext.path)},
                      label: ${JSON.stringify(ext.label)},
                      section: ${JSON.stringify(ext.section || null)},
                      plugin: ${JSON.stringify(ext.plugin)},
                      component: Ext_${idx}
                    }`).join(',\n');

                    return `
                      ${imports}
                      
                      export const adminExtensions = [
                        ${configExports}
                      ];
                    `;
                  }
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
