// Explicit browser-test configuration; the normal playground stays on local auth.
import { HybridAuthAdapter } from 'talisman-cms/auth/hybrid';
import { playgroundConfig } from './astro.config.mjs';

export default playgroundConfig(HybridAuthAdapter());
