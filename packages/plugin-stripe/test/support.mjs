// Serves the Worker env, the plugin's virtual modules and a CMS auth adapter to the built routes and
// hooks, and answers Stripe API calls without leaving the process. Import it before those modules.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

export const env = {};
export const stripeConfig = { rest: false, restMethods: [], logs: false, webhooks: undefined };
export const nativeSchemas = {};
globalThis.__stripePluginTest = { env, stripeConfig, nativeSchemas };

const modules = {
  'cloudflare:workers': 'export const env = globalThis.__stripePluginTest.env;',
  'virtual:talisman-cms/stripe-config': 'export const stripeConfig = globalThis.__stripePluginTest.stripeConfig;',
  'virtual:talisman-cms/native-schemas': 'export const nativeSchemas = globalThis.__stripePluginTest.nativeSchemas;',
  // The role comes from a test header, so each request states who is calling.
  'virtual:talisman-cms/auth': `export const authConfigured = true;
export const authAdapter = { async getUser(request) {
  const role = request.headers.get('x-test-role');
  return role ? { id: role, email: role + '@example.test', role } : null;
} };`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!Object.hasOwn(modules, specifier)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  },
});

export function resetEnv(values = {}) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
}

export function cmsRequest(role, method = 'POST') {
  return new Request('https://cms.example.test/admin/api/collections/products/entries/p1', {
    method,
    headers: role ? { 'x-test-role': role } : {},
  });
}

/** Records Stripe API calls; `respond` returns the JSON body for a call. */
export function mockStripe(t, respond = defaultResponse) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    assert.equal(url.hostname, 'api.stripe.com', `unexpected fetch: ${url}`);
    const call = {
      method: init.method,
      path: url.pathname,
      params: Object.fromEntries(new URLSearchParams(typeof init.body === 'string' ? init.body : '')),
      authorization: new Headers(init.headers).get('authorization'),
    };
    calls.push(call);
    return Response.json(respond(call), { headers: { 'request-id': `req_${calls.length}` } });
  });
  return calls;
}

const idPrefixes = { customers: 'cus', products: 'prod', prices: 'price' };

function defaultResponse({ method, path }) {
  const [, , resource, id] = path.split('/');
  const object = resource.replace(/s$/, '');
  if (method === 'DELETE') return { id, object, deleted: true };
  return { id: id ?? `${idPrefixes[resource]}_created`, object };
}
