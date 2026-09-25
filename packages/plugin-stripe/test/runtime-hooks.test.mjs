import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripePlugin } from '../dist/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const loadRuntimeConfig = (plugin) => plugin.vite.plugins[0].load('\0virtual:talisman-cms/stripe-config');

test('Stripe sync hooks are registered as Worker-loadable modules', () => {
  const sync = {
    collection: 'products',
    stripeResourceType: 'products',
    stripeResourceTypeSingular: 'product',
    fields: [{ fieldPath: 'name', stripeProperty: 'name' }],
  };
  const plugin = stripePlugin({ sync: [sync], rest: true });
  const options = plugin.onInit({ collections: [{ name: 'Products', slug: 'products', fields: [] }] });
  const product = options.collections.find((collection) => collection.slug === 'products');

  assert.equal(product.runtimeHooks?.[0].moduleId, '@talisman-cms/plugin-stripe/runtime-hooks');
  assert.equal(product.runtimeHooks?.[0].exportName, 'createStripeRuntimeHooks');
  assert.deepEqual(product.runtimeHooks?.[0].args, sync);
  // The hooks own the Stripe ID; it is not an editable form field.
  assert.deepEqual(product.fields, []);
  assert.equal(plugin.endpoints.some((endpoint) => endpoint.path === '/stripe/rest'), false);
});

test('inline webhook handlers are rejected instead of silently disappearing', () => {
  assert.throws(
    () => stripePlugin({ webhooks: () => {} }),
    /webhooksModule/,
  );
});

test('Stripe secrets in astro.config are ignored and never reach the server bundle', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const plugin = stripePlugin({
    stripeSecretKey: 'sk_live_from_config',
    stripeWebhooksEndpointSecret: 'whsec_from_config',
    rest: true,
    restMethods: ['customers.retrieve'],
    logs: true,
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /STRIPE_SECRET_KEY and TALISMAN_STRIPE_WEBHOOK_SECRET Worker secrets/);

  const source = loadRuntimeConfig(plugin);
  assert.doesNotMatch(source, /sk_live_from_config|whsec_from_config|stripeSecretKey|stripeWebhooksEndpointSecret/);
  const { stripeConfig } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(stripeConfig, { rest: true, restMethods: ['customers.retrieve'], logs: true, webhooks: undefined });
});

test('the public webhook endpoint is injected only when enabled', () => {
  const webhookPaths = (config) => stripePlugin(config).endpoints.filter((endpoint) => endpoint.path === '/stripe/webhooks');
  const webhooksModule = { moduleId: './src/stripe-webhooks.ts', exportName: 'handlers' };

  assert.deepEqual(webhookPaths(), []);
  assert.deepEqual(webhookPaths({ sync: [] }), []);
  assert.deepEqual(webhookPaths({ webhooksModule, webhookEndpoint: false }), []);
  for (const config of [{ webhookEndpoint: true }, { webhooksModule }]) {
    const [endpoint] = webhookPaths(config);
    assert.equal(endpoint.public, true);
    assert.ok(existsSync(endpoint.entrypoint), endpoint.entrypoint);
  }
  assert.match(loadRuntimeConfig(stripePlugin({ webhooksModule })), /import \{ handlers as runtimeWebhooks \} from "\.\/src\/stripe-webhooks\.ts"/);
});

test('every published entry point and the files it imports are in the package', () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const shipped = (file) => manifest.files.some((entry) => !relative(join(packageDir, entry), file).startsWith('..'));
  const targets = (value) => typeof value === 'string' ? [value] : Object.values(value).flatMap(targets);

  for (const target of targets(manifest.exports)) {
    assert.ok(shipped(join(packageDir, target)), `${target} is exported but not in "files"`);
  }

  const filesIn = (path) => !existsSync(path) ? [] : !statSync(path).isDirectory() ? [path]
    : readdirSync(path).flatMap((name) => filesIn(join(path, name)));
  for (const file of manifest.files.flatMap((entry) => filesIn(join(packageDir, entry))).filter((path) => /\.[mc]?[jt]s$/.test(path))) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
      const target = [specifier, `${specifier}.ts`, `${specifier}.js`, specifier.replace(/\.js$/, '.d.ts')]
        .map((candidate) => resolve(dirname(file), candidate)).find(existsSync);
      assert.ok(target && shipped(target), `${relative(packageDir, file)} imports unshipped ${specifier}`);
    }
  }
});
