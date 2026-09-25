// Node module hooks for importing packed entry points outside Astro, Vite and Workers. `astro:*`,
// `virtual:*` and `cloudflare:*` modules exist only there, so each gets a stub exporting the names
// its importer asks for. Every other import resolves normally from the consumer project.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubbed = /^(astro|virtual|cloudflare):/;

export async function resolve(specifier, context, next) {
  if (!stubbed.test(specifier)) return next(specifier, context);
  const names = new Set();
  if (context.parentURL?.startsWith('file:')) {
    const source = readFileSync(fileURLToPath(context.parentURL), 'utf8');
    const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:import|export)\\s*(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${quoted}["']`, 'g');
    for (const [, list] of source.matchAll(pattern)) {
      for (const item of list.split(',')) {
        const name = item.trim().split(/\s+as\s+/)[0];
        if (name && name !== 'default') names.add(name);
      }
    }
  }
  return { url: `smoke-stub:${specifier}?${[...names].join(',')}`, shortCircuit: true };
}

export async function load(url, context, next) {
  if (!url.startsWith('smoke-stub:')) return next(url, context);
  const names = url.slice(url.indexOf('?') + 1).split(',').filter(Boolean);
  const source = [
    'const stub = new Proxy(function () {}, {',
    "  get: (target, key) => (key === 'then' ? undefined : key === 'prototype' ? {} : key === Symbol.toPrimitive ? () => '' : stub),",
    '  apply: () => stub,',
    '  construct: () => stub,',
    '});',
    'export default stub;',
    ...names.map((name) => `export const ${name} = stub;`),
  ].join('\n');
  return { format: 'module', source, shortCircuit: true };
}
