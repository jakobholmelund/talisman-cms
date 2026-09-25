import { T as TalismanAuthAdapter } from './types-B9Ys5hZL.js';
import 'astro';

declare function registerAuthAdapter(key: string, adapter: TalismanAuthAdapter | null | undefined): void;
declare function getRegisteredAuthAdapter(key: string): TalismanAuthAdapter | null;

export { getRegisteredAuthAdapter, registerAuthAdapter };
