import { defineConfig } from 'drizzle-kit';

// The core's migrations are generated from its Drizzle schema files: `pnpm db:generate` writes the
// next `drizzle/<timestamp>_<name>/migration.sql`. See CLAUDE.md, "Migrations".
export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/auth/local-schema.ts'],
  out: './drizzle',
});
