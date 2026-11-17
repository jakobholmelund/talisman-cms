import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModule, pluginAdmin } from './helpers/admin-source.mjs';
const { reconcileVariantDrafts } = await import(compileModule(new URL('variant-drafts.ts', pluginAdmin)));
const value = (id, name, version = 1) => ({ id, localId: id, value: name, updatedAt: version });
const group = (values) => ({ id: 'g', localId: 'g', name: 'Size', updatedAt: 1, values });

test('saving one value preserves neighboring edits and their original concurrency version', () => {
  const baseline = [group([value('a', 'Small'), value('b', 'Large')])];
  const drafts = [group([value('a', 'S'), value('b', 'L')])];
  const fresh = [group([value('a', 'S', 2), value('b', 'Changed by another admin', 3)])];
  const merged = reconcileVariantDrafts(baseline, drafts, fresh, { kind: 'value', localId: 'a' });
  assert.deepEqual(merged[0].values, [value('a', 'S', 2), value('b', 'L', 1)]);
});
test('saving a group preserves its unsaved values; new saved rows do not duplicate local drafts', () => {
  const baseline = [group([value('a', 'Small')])];
  const added = { ...value('new-local', 'Medium'), id: null };
  const drafts = [{ ...group([value('a', 'S'), added]), name: 'Fit' }];
  const fresh = [{ ...group([value('a', 'Small')]), name: 'Fit', updatedAt: 2 }];
  const merged = reconcileVariantDrafts(baseline, drafts, fresh, { kind: 'group', localId: 'g' });
  assert.equal(merged[0].updatedAt, 2); assert.deepEqual(merged[0].values, drafts[0].values);
  fresh[0].values.push(value('new-saved', 'Medium', 2));
  const afterCreate = reconcileVariantDrafts(baseline, drafts, fresh, { kind: 'value', localId: 'new-local' });
  assert.deepEqual(afterCreate[0].values.map(v => v.localId), ['a', 'new-saved']);
});
test('refresh keeps deleted dirty drafts recoverable; explicit discard accepts the latest snapshot', () => {
  const baseline = [group([value('a', 'Small')])];
  const drafts = [group([value('a', 'Changed')])];
  assert.deepEqual(reconcileVariantDrafts(baseline, drafts, []), drafts);
  assert.deepEqual(reconcileVariantDrafts(baseline, drafts, [], 'all'), []);
  assert.deepEqual(reconcileVariantDrafts(baseline, baseline, []), []);
});
