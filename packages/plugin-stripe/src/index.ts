import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Plugin } from 'talisman-cms';
import type { StripePluginConfig, StripeRuntimeConfig } from './types';

export * from './types';

function resolveRouteEntrypoint(name: string) {
  let routePath = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(routePath)) routePath = fileURLToPath(new URL(`./routes/${name}.ts`, import.meta.url));
  return routePath;
}

export function stripePlugin(config: StripePluginConfig = {}): Plugin {
  if (config.webhooks && !config.webhooksModule) {
    throw new Error('[plugin-stripe] Inline webhook handlers cannot survive the server build. Provide webhooksModule.');
  }
  const ignoredSecrets = (['stripeSecretKey', 'stripeWebhooksEndpointSecret'] as const).filter((key) => config[key] !== undefined);
  if (ignoredSecrets.length) {
    console.warn(`[plugin-stripe] ${ignoredSecrets.join(' and ')} in astro.config is ignored. `
      + 'Set the STRIPE_SECRET_KEY and TALISMAN_STRIPE_WEBHOOK_SECRET Worker secrets instead, and remove the key from your config.');
  }
  const webhookEndpoint = config.webhookEndpoint ?? Boolean(config.webhooksModule);
  // Only these options reach the server bundle; Stripe secrets are read from the Worker per request.
  const runtimeConfig: Omit<StripeRuntimeConfig, 'webhooks'> = {
    rest: config.rest === true,
    restMethods: config.restMethods ?? [],
    logs: config.logs === true,
  };

  return {
    name: 'stripe-plugin',
    onInit: (cmsConfig) => {
      // The Stripe ID is kept in each record's data (or the native column) but is not a form field,
      // because the hooks overwrite any value sent by the admin or an API client.
      if (config.sync && cmsConfig.collections) {
        config.sync.forEach((syncOpt: any) => {
          const col = cmsConfig.collections!.find((c: any) => c.slug === syncOpt.collection);
          if (col) {
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
              const handlerImport = config.webhooksModule
                ? `import { ${config.webhooksModule.exportName} as runtimeWebhooks } from ${JSON.stringify(config.webhooksModule.moduleId)};`
                : '';
              return `${handlerImport}\nexport const stripeConfig = { ...${JSON.stringify(runtimeConfig)}, webhooks: ${config.webhooksModule ? 'runtimeWebhooks' : 'undefined'} };`;
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
        entrypoint: resolveRouteEntrypoint('rest')
      }] : []),
      ...(webhookEndpoint ? [{
        path: '/stripe/webhooks',
        entrypoint: resolveRouteEntrypoint('webhooks'),
        public: true
      }] : [])
    ]
  };
}
