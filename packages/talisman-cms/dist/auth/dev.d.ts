import { T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import 'astro';

/**
 * A mock adapter for `astro dev` on a loopback address only. It signs every request in as an admin.
 * The integration refuses it for `astro build` and for a dev server exposed with `--host`, and it
 * authenticates nothing outside the Vite dev server, whatever the request's Host header says.
 */
declare function DevAuthAdapter(): TalismanAuthAdapter;

export { DevAuthAdapter };
