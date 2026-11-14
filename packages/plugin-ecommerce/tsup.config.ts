import { defineConfig } from 'tsup';

// Coverage builds are disposable; normal package archives do not ship source maps.
export default defineConfig({ sourcemap: process.env.TALISMAN_COVERAGE === '1' });
