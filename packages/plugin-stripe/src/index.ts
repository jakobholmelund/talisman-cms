import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Plugin, CollectionConfig, FieldDefinition } from 'talisman-cms';
import type { StripePluginConfig } from './types';

export * from './types';

function resolveRouteEntrypoint(name: string) {
  // Use import.meta.url for esm environment, fallback for CJS
  const isESM = typeof import.meta !== 'undefined' && typeof import.meta.url === 'string';
  
  if (!isESM) {
    // Basic fallback for CJS bundlers 
    return `../src/routes/${name}.ts`;
  }

  let routePath = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));

  if (!existsSync(routePath)) {
    routePath = fileURLToPath(new URL(`../src/routes/${name}.ts`, import.meta.url));
  }

  return routePath;
}

export function stripePlugin(config: StripePluginConfig): Plugin {
  if (config.webhooks && !config.webhooksModule) {
    throw new Error('[plugin-stripe] Inline webhook handlers cannot survive the server build. Provide webhooksModule.');
  }
  const restEndpointPath = resolveRouteEntrypoint('rest');
  const webhooksEndpointPath = resolveRouteEntrypoint('webhooks');

  return {
    name: 'stripe-plugin',
    onInit: (cmsConfig) => {
      // 1. Inject sync fields
      if (config.sync && cmsConfig.collections) {
        config.sync.forEach((syncOpt: any) => {
          const col = cmsConfig.collections!.find((c: any) => c.slug === syncOpt.collection);
          if (col) {
            col.fields = col.fields || [];
            
            if (!col.fields.some((f: any) => f.name === 'stripeID')) {
              col.fields.push({
                name: 'stripeID',
                label: 'Stripe ID',
                type: 'text',
                admin: { hidden: true }
              } as FieldDefinition); 
            }

            if (!col.fields.some((f: any) => f.name === 'skipSync')) {
              col.fields.push({
                name: 'skipSync',
                label: 'Skip Stripe Sync',
                type: 'boolean',
                defaultValue: false,
                admin: { hidden: true },
                description: 'When true, prevents infinite sync loops when webhooks trigger updates'
              } as FieldDefinition);
            }

            col.runtimeHooks = [
              ...(col.runtimeHooks || []),
              {
                moduleId: '@talisman-cms/plugin-stripe/runtime-hooks',
                exportName: 'createStripeRuntimeHooks',
                factory: true,
                args: syncOpt
              }
            ];
          }
        });
      }

      return cmsConfig;
    },
    vite: {
      plugins: [
        {
          name: 'talisman-cms-stripe-plugin-config',
          resolveId(id: string) {
            if (id === 'virtual:talisman-cms/stripe-config') {
              return '\0virtual:talisman-cms/stripe-config';
            }
          },
          load(id: string) {
            if (id === '\0virtual:talisman-cms/stripe-config') {
              const { webhooks, ...serializableConfig } = config;
              const handlerImport = config.webhooksModule
                ? `import { ${config.webhooksModule.exportName} as runtimeWebhooks } from ${JSON.stringify(config.webhooksModule.moduleId)};`
                : '';
              return `${handlerImport}\nexport const stripeConfig = { ...${JSON.stringify(serializableConfig)}, webhooks: ${config.webhooksModule ? 'runtimeWebhooks' : 'undefined'} };`;
            }
          }
        }
      ],
      ssr: {
        noExternal: ['@talisman-cms/plugin-stripe']
      }
    },
    endpoints: [
      ...(config.rest === true && config.restMethods?.length ? [{
        path: '/stripe/rest',
        entrypoint: restEndpointPath
      }] : []),
      {
        path: '/stripe/webhooks',
        entrypoint: webhooksEndpointPath,
        public: true
      }
    ]
  };
}
