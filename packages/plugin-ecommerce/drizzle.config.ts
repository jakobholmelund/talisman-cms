import { defineConfig } from 'drizzle-kit';

// The plugin's migrations are generated from its Drizzle schema: `pnpm db:generate` writes the next
// `drizzle/<timestamp>_<name>/migration.sql`; triggers go in a `db:generate:custom` file. See CLAUDE.md, "Migrations".
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
