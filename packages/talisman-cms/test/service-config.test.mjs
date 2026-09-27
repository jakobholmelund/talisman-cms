import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime, skip } from './helpers/handler-harness.mjs';

let config;
if (!skip) config = await import('../src/service/config.ts');

test('the service reads the virtual modules statically in the handler and dynamically in getClient', { skip }, async () => {
  // The handler passes the modules it imports; a missing module contributes nothing.
  const empty = config.configFromModules({});
  assert.deepEqual(empty, {
    collections: [], globals: [], uiLibraries: [], nativeSchemas: {}, collectionHooks: {},
    publishingWorkflowBinding: 'TALISMAN_PUBLISH_WORKFLOW',
  });
  const fromModules = config.configFromModules({
    config: { collections: runtime.collections, globals: runtime.globals, publishing: { workflowBinding: 'SITE_PUBLISH_WORKFLOW' } },
    nativeSchemas: { nativeSchemas: runtime.nativeSchemas },
    collectionHooks: { collectionHooks: runtime.collectionHooks },
  });
  assert.equal(fromModules.collections, runtime.collections, 'the configured arrays are shared, not copied');
  assert.equal(fromModules.publishingWorkflowBinding, 'SITE_PUBLISH_WORKFLOW');

  // getClient loads the same modules dynamically; here the test stubs stand in for Vite.
  const loaded = await config.loadServiceConfig();
  assert.equal(loaded.collections, runtime.collections);
  assert.equal(loaded.globals, runtime.globals);
  assert.equal(loaded.nativeSchemas, runtime.nativeSchemas);
  assert.equal(loaded.collectionHooks, runtime.collectionHooks);
  assert.equal(loaded.publishingWorkflowBinding, 'SITE_PUBLISH_WORKFLOW');
  assert.equal(await config.loadServiceConfig(), loaded, 'loaded once');
});
