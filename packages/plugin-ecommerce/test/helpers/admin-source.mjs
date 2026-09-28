import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** The core's admin UI source and the plugin's admin screens, which both ship as TypeScript source. */
export const coreUi = new URL('../../../talisman-cms/ui/', import.meta.url);
export const pluginAdmin = new URL('../../src/admin/', import.meta.url);

/**
 * Compiles one admin source module and gives it back as a data URL to import. `links` maps the
 * specifiers it imports to modules loaded the same way, so a helper may import the core's own UI
 * helpers; type-only imports are erased by the compiler. A specifier left unlinked fails the test,
 * so a new import cannot slip into a module a test loads this way.
 */
export function compileModule(url, links = {}) {
  let { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [specifier, linked] of Object.entries(links)) {
    outputText = outputText.replaceAll(`from '${specifier}'`, `from '${linked}'`).replaceAll(`from "${specifier}"`, `from "${linked}"`);
  }
  assert.doesNotMatch(outputText, /^import\s.*\bfrom\s+['"](?!data:)/m, `${url.pathname} imports a module this test does not link`);
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}
