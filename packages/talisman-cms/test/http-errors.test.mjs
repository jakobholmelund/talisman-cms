import assert from 'node:assert/strict';
import test from 'node:test';
import { call, database, doc, runtime, skip } from './helpers/handler-harness.mjs';

let errors;
let httpErrors;
let versioning;
if (!skip) {
  errors = await import('../src/service/errors.ts');
  httpErrors = await import('../src/api/http-errors.ts');
  versioning = await import('../src/versioning.ts');
}

const generic = (message) => ({ status: 'error', error: message, message });

test('every service error maps to its status and body in one place', { skip }, async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const { HttpError, INTERNAL_ERROR_MESSAGE, toErrorResponse } = httpErrors;
  const issue = { path: ['title'], message: 'Required' };
  const cases = [
    [new errors.ValidationError([issue]), 400, { error: 'Some fields are invalid: title', fieldErrors: { title: ['Required'] }, issues: [issue] }],
    [new errors.ValidationError([{ path: [], message: 'Global data must be a JSON object' }], { details: { formErrors: ['x'] } }), 400,
      { error: 'Global data must be a JSON object', fieldErrors: {}, issues: [{ path: [], message: 'Global data must be a JSON object' }], details: { formErrors: ['x'] } }],
    [new errors.AccessDeniedError(), 403, { error: 'Collection access denied' }],
    [new errors.NotFoundError('Entry not found'), 404, { error: 'Entry not found' }],
    [new errors.PayloadTooLargeError(), 413, { error: 'The request body is too large.' }],
    [new errors.PreconditionRequiredError(), 428, { error: 'expectedRevisionId is required' }],
    [new errors.NativeRecordConflictError(), 409, { error: 'This record changed since it was opened. Reload it before saving.' }],
    [new errors.UnsupportedOperationError('Publishing workflows are not available for native collections'), 400,
      { error: 'Publishing workflows are not available for native collections' }],
    [new HttpError(400, 'The cursor is not valid.'), 400, { error: 'The cursor is not valid.' }],
    [new HttpError(404, 'Collection nope not found'), 404, { error: 'Collection nope not found' }],
    [new versioning.RevisionConflictError(), 409, { error: 'This entry changed since it was opened. Reload it before saving.' }],
    [new versioning.SlugConflictError(), 409, { error: 'Another entry in this collection already uses this slug.' }],
    [new versioning.EntryNotFoundError('Entry x not found'), 404, { error: 'Entry x not found' }],
    [new Error('D1_ERROR: UNIQUE constraint failed: galaxy_entries.id: SQLITE_CONSTRAINT'), 409, { error: 'Another record already uses this id.' }],
    [new Error('NOT NULL constraint failed: test_parts.name'), 400, { error: 'A value is required for name.' }],
    [new Error('Failed query: INSERT INTO t VALUES (?) params: secret', { cause: new Error('FOREIGN KEY constraint failed') }), 409,
      { error: 'This change conflicts with a related record.' }],
    // A hook's own message reaches the editor; a database failure inside a hook does not.
    [new errors.HookError(new Error('Stripe refused the price'), 'beforeChange'), 500, generic('Stripe refused the price')],
    [new errors.HookError(new Error('Failed query: SELECT secret params: 1'), 'afterChange'), 500, generic(INTERNAL_ERROR_MESSAGE)],
    [new Error('Failed query: SELECT secret params: 1'), 500, generic(INTERNAL_ERROR_MESSAGE)],
    [new TypeError('boom'), 500, generic(INTERNAL_ERROR_MESSAGE)],
  ];
  for (const [error, status, body] of cases) {
    const response = toErrorResponse(error, 'test');
    assert.equal(response.status, status, `${error.name}: ${error.message}`);
    assert.deepEqual(await response.json(), body, `${error.name}: ${error.message}`);
  }
  assert.equal(logged.mock.callCount(), 4, 'only the 500s are logged');

  assert.equal(new errors.HookError(new Error('x'), 'afterDelete').committed, true);
  assert.equal(new errors.HookError(new Error('x'), 'beforeDelete').committed, false);
  assert.equal(new errors.HookError('not an error', 'beforeChange').message, 'A collection hook failed');
  assert.equal(errors.isServiceError(new errors.NotFoundError('x')), true);
  assert.equal(errors.isServiceError(new versioning.EntryNotFoundError('x')), false);
  assert.equal(errors.constraintErrorFrom(new Error('Failed query: INSERT ... params: 1')), null, 'the statement text itself is never parsed');
});

test('a hook that throws a service error keeps its status; other hook failures answer 500 with their message', { skip }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const sqlite = database();
  const stored = () => sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_entries').get().total;
  const create = (title) => call('POST', '/collections/posts/entries', { data: { title, body: doc('Text') } });
  try {
    runtime.collectionHooks.posts = {
      beforeValidate: [({ data }) => {
        if (data.title === 'refused') throw new errors.ValidationError([{ path: ['title'], message: 'Not this title' }]);
      }],
      beforeChange: [({ data }) => {
        if (data.title === 'forbidden') throw new errors.AccessDeniedError('This collection is written by the sync only');
        if (data.title === 'broken') throw new Error('The sync failed');
      }],
    };
    const refused = await create('refused');
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.fieldErrors, { title: ['Not this title'] });
    const forbidden = await create('forbidden');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, 'This collection is written by the sync only');
    const broken = await create('broken');
    assert.equal(broken.status, 500);
    assert.equal(broken.body.error, 'The sync failed');
    assert.equal(stored(), 0, 'a refused write stores nothing');

    // A failure after the write keeps the row and still tells the editor.
    runtime.collectionHooks.posts = { afterChange: [() => { throw new Error('The notification failed'); }] };
    const kept = await create('kept');
    assert.equal(kept.status, 500);
    assert.equal(kept.body.error, 'The notification failed');
    assert.equal(stored(), 1);
  } finally {
    delete runtime.collectionHooks.posts;
    sqlite.close();
  }
});
