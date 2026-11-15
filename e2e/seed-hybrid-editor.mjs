// Generate SQL for the disposable local D1 fixture. This script never connects to a database.
// Resolve the installed auth implementation from core so the hash matches its password verifier.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../packages/talisman-cms/package.json', import.meta.url));
const { hashPassword } = await import(pathToFileURL(require.resolve('better-auth/crypto')).href);
const password = await hashPassword('E2E-editor-password-2026');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const now = Math.floor(Date.now() / 1000);
console.log(`INSERT INTO galaxy_auth_user (id, name, email, email_verified, created_at, updated_at, role, banned)
VALUES ('hybrid-editor', 'Hybrid editor', 'hybrid-editor@example.com', 1, ${now}, ${now}, 'editor', 0);
INSERT INTO galaxy_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES ('hybrid-editor-credential', 'hybrid-editor', 'credential', 'hybrid-editor', ${quote(password)}, ${now}, ${now});`);
