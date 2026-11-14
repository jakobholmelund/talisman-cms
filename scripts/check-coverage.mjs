import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkCoverage(summary, files, thresholds) {
  const totals = Object.fromEntries(Object.keys(thresholds).map(metric => [metric, { total: 0, covered: 0 }]));
  for (const file of files) {
    const entry = summary[file];
    if (!entry || !entry.functions?.total) throw new Error(`Missing executable source coverage: ${file}`);
    for (const metric of Object.keys(totals)) {
      const value = entry[metric];
      if (!Number.isFinite(value?.total) || !Number.isFinite(value?.covered) || value.covered > value.total || value.covered < 0) {
        throw new Error(`Invalid ${metric} coverage: ${file}`);
      }
      totals[metric].total += value.total;
      totals[metric].covered += value.covered;
    }
  }
  if (!files.length) throw new Error('Coverage scope must contain source files');
  return Object.fromEntries(Object.entries(totals).map(([metric, { total, covered }]) => {
    if (!total) throw new Error(`Missing ${metric} measurements`);
    const percent = 100 * covered / total;
    if (percent < thresholds[metric]) throw new Error(`${metric}: ${percent.toFixed(2)}% is below ${thresholds[metric]}%`);
    return [metric, percent.toFixed(2)];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const summary = JSON.parse(readFileSync(resolve(root, 'coverage/coverage-summary.json'), 'utf8'));
  const auth = resolve(root, 'packages/talisman-cms/src/auth');
  const scopes = [
    { name: 'Authentication', files: readdirSync(auth).filter(file => file.endsWith('.ts') && !['types.ts', 'local-schema.ts'].includes(file)).map(file => resolve(auth, file)),
      thresholds: { lines: 94, branches: 90, functions: 85 } },
    { name: 'Commerce money paths', files: ['money', 'checkout', 'orders', 'stripe-events', 'gift-cards', 'tax', 'promotions', 'referrals']
      .map(file => resolve(root, `packages/plugin-ecommerce/src/${file}.ts`)),
      thresholds: { lines: 95, branches: 85, functions: 95 } },
  ];
  const rows = ['| Scope | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: |'];
  for (const scope of scopes) {
    const result = checkCoverage(summary, scope.files, scope.thresholds);
    rows.push(`| ${scope.name} | ${result.lines}% | ${result.branches}% | ${result.functions}% |`);
  }
  const report = rows.join('\n') + '\n';
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
