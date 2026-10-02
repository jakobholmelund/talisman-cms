import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { starwindUiLibrary } from '@talisman-cms/plugin-ui-starwind';

// A render-only harness. Use the real generated module paths and core slot/preset renderers.
const library = starwindUiLibrary();
const registryModule = (entries, name, field) => entries.map((entry, index) => `import R${index} from ${JSON.stringify(entry.renderer.modulePath)};`).join('\n')
  + `\nexport const ${name} = {${entries.map((entry, index) => `${JSON.stringify(entry[field].slug)}: R${index}`).join(',')}};`;
const modules = {
  'virtual:talisman-cms/block-renderers': registryModule(library.blocks, 'blockRenderers', 'block'),
  'virtual:talisman-cms/component-renderers': registryModule(library.components, 'componentRenderers', 'component'),
};
export default defineConfig({
  vite: { plugins: [tailwindcss(), {
    name: 'talisman-composition-test-registries',
    resolveId(id) { if (id in modules) return `\0${id}`; },
    load(id) { return modules[id.replace(/^\0/, '')]; },
  }] },
});
