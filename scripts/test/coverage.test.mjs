import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCoverage } from '../check-coverage.mjs';

const metric = (covered, total) => ({ covered, total });
const entry = (covered = 9, total = 10) => Object.fromEntries(['lines', 'branches', 'functions'].map(key => [key, metric(covered, total)]));
const thresholds = { lines: 80, branches: 80, functions: 80 };

test('coverage gates weight counts across files instead of averaging percentages', () => {
  const result = checkCoverage({ a: entry(9, 10), b: entry(1, 1) }, ['a', 'b'], thresholds);
  assert.equal(result.lines, '90.91');
  assert.throws(() => checkCoverage({ a: entry(0, 10), b: entry(1, 1) }, ['a', 'b'], thresholds), /below/);
});

test('missing files, unmapped bundled functions and empty scopes cannot pass a coverage gate', () => {
  assert.throws(() => checkCoverage({}, ['missing'], thresholds), /Missing executable/);
  assert.throws(() => checkCoverage({ a: { ...entry(), functions: metric(0, 0) } }, ['a'], thresholds), /Missing executable/);
  assert.throws(() => checkCoverage({}, [], thresholds), /must contain/);
  assert.throws(() => checkCoverage({ a: entry(11, 10) }, ['a'], thresholds), /Invalid/);
});
