import { T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import { TalismanEnv } from '../client.js';
export { getAccessEmail } from './access.js';
import 'astro';
import 'drizzle-orm/d1';
import '../media-Cfo_aHOS.js';
import 'drizzle-orm/sqlite-core';

type LocalEnv = TalismanEnv & {
    GALAXY_AUTH_SECRET?: string;
    GALAXY_AUTH_SETUP_TOKEN?: string;
    GALAXY_ACCESS_TEAM_DOMAIN?: string;
    GALAXY_ACCESS_AUDIENCE?: string;
};
declare function getLocalAuthEnv(): Promise<LocalEnv>;
declare function createInitialAdmin(request: Request, env: LocalEnv, adminPath: string, details: {
    email: string;
    name: string;
    password: string;
}): Promise<void>;
declare function LocalAuthAdapter(adminPath?: string): TalismanAuthAdapter;

export { LocalAuthAdapter, createInitialAdmin, getLocalAuthEnv };
