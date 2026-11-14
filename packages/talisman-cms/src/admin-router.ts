import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { TanStackRouterVite, tanStackRouterCodeSplitter } from '@tanstack/router-vite-plugin';

/** Installed packages ship their route tree. Only a source checkout may regenerate it. */
export function adminRouterPlugins(uiDirectory: string): ReturnType<typeof TanStackRouterVite> {
  const ui = realpathSync(uiDirectory);
  const routesDirectory = join(ui, 'routes');
  const options = {
    routesDirectory,
    generatedRouteTree: join(ui, 'routeTree.gen.ts'),
    autoCodeSplitting: true,
  };
  if (!ui.split(/[\\/]/).includes('node_modules')) return TanStackRouterVite(options);

  // The composed plugin's splitter depends on a map populated by its generator. Simply setting
  // enableRouteGeneration:false silently disables splitting in the pinned plugin version.
  // Use the standalone splitter with the literal IDs already stamped into our shipped routes.
  const routesByFile = new Map<string, { routeId: string }>();
  function readRoutes(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) readRoutes(path);
      else if (entry.name === '__root.tsx') routesByFile.set(path.replace(/\\/g, '/'), { routeId: '/__root' });
      else if (entry.name.endsWith('.tsx')) {
        const source = readFileSync(path, 'utf8');
        const route = source.match(/export\s+const\s+Route\s*=\s*createFileRoute\(\s*(['"])([^'"\r\n]+)\1\s*\)/);
        if (!route) throw new Error(`Talisman CMS: missing generated route ID in ${path}. Rebuild the package before publishing.`);
        routesByFile.set(path.replace(/\\/g, '/'), { routeId: route[2] });
      }
    }
  }
  readRoutes(routesDirectory);
  return tanStackRouterCodeSplitter(options, { routesByFile });
}
