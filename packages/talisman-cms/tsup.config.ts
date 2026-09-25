import { defineConfig } from 'tsup';

const watchMode = process.argv.includes('--watch');

export default defineConfig({
  entry: ['src/integration.ts', 'src/client.ts', 'src/helpers.ts', 'src/env.ts', 'src/email/index.ts', 'src/email/runtime.ts', 'src/seo.ts', 'src/loader.ts', 'src/loader.server.ts', 'src/runtime-config.ts', 'src/auth/dev.ts', 'src/auth/access.ts', 'src/auth/hybrid.ts', 'src/auth/identity.ts', 'src/auth/collection-access.ts', 'src/auth/local.ts', 'src/auth/authorize.ts', 'src/auth/guard.ts', 'src/workflows.ts', 'src/versioning.ts', 'src/db/schema.ts', 'src/db/media.ts', 'src/db/media-policy.ts', 'src/render.ts', 'src/richtext.ts', 'src/ui-library-manifest.ts', 'src/toolbar/app.ts'],
  format: ['esm'],
  dts: true,
  clean: !watchMode,
  external: [
    'astro',
    'astro/toolbar',
    'react',
    'react-dom',
    // Peer dependency: bundling it would ship a second ORM copy next to the app's own.
    'drizzle-orm',
    '@tailwindcss/vite',
    'tailwindcss',
    '@tanstack/router-vite-plugin',
    '@tanstack/react-router',
    'virtual:talisman-cms/auth',
    'virtual:talisman-cms/config',
    'virtual:talisman-cms/email',
    'virtual:talisman-cms/native-schemas',
    'virtual:talisman-cms/ui-libraries',
    'cloudflare:workers',
    'cloudflare:workflows'
  ]
});
