import { defineConfig } from 'tsup';

const watchMode = process.argv.includes('--watch');

export default defineConfig({
  entry: ['src/integration.ts', 'src/client.ts', 'src/helpers.ts', 'src/seo.ts', 'src/loader.ts', 'src/loader.server.ts', 'src/runtime-config.ts', 'src/auth/dev.ts', 'src/auth/access.ts', 'src/auth/collection-access.ts', 'src/auth/local.ts', 'src/auth/authorize.ts', 'src/auth/guard.ts', 'src/workflows.ts', 'src/versioning.ts', 'src/db/schema.ts', 'src/db/media.ts', 'src/db/media-policy.ts', 'src/render.ts', 'src/ui-library-manifest.ts', 'src/toolbar/app.ts'],
  format: ['esm'],
  dts: true,
  clean: !watchMode,
  external: [
    'astro',
    'astro/toolbar',
    'react',
    'react-dom',
    '@tailwindcss/vite',
    'tailwindcss',
    '@tanstack/router-vite-plugin',
    '@tanstack/react-router',
    'virtual:talisman-cms/auth',
    'virtual:talisman-cms/config',
    'virtual:talisman-cms/native-schemas',
    'virtual:talisman-cms/ui-libraries',
    'cloudflare:workers',
    'cloudflare:workflows'
  ]
});
