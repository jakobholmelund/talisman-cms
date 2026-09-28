import { AstroGlobal } from 'astro';

interface TalismanUser {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    role: 'admin' | 'editor';
}
interface TalismanAuthRuntimeDescriptor {
    /**
     * Module specifier that can recreate this adapter in the built server runtime.
     */
    moduleId: string;
    /**
     * Named export to import from `moduleId`.
     */
    exportName: string;
    /**
     * Whether the export is a ready-to-use adapter value or a factory function.
     * @default 'factory'
     */
    type?: 'factory' | 'value';
    /** JSON-serializable arguments for a runtime factory. */
    args?: unknown[];
    /**
     * When true, the integration passes its normalized admin path as the factory's first argument, before
     * `args`, so the adapter and the integration always agree on it.
     */
    adminPath?: boolean;
    /**
     * The admin path the site passed to the factory itself, normalized, when it passed one. The
     * integration fails the build when it differs from its own `adminPath` option.
     */
    configuredAdminPath?: string;
}
interface TalismanAuthAdapter {
    /**
     * Evaluates the current incoming request and returns the authenticated user if valid.
     */
    getUser(req: Request | AstroGlobal['request']): Promise<TalismanUser | null>;
    /**
     * Triggers the sign-in flow. For SSR redirects, this might throw a Response.
     */
    signIn(req: Request | AstroGlobal['request']): Promise<Response>;
    /**
     * Destroys the current session.
     */
    signOut(req: Request | AstroGlobal['request']): Promise<Response>;
    /** Optional handler for /api/auth/* routes owned by this adapter. */
    handle?(req: Request | AstroGlobal['request']): Promise<Response>;
    /**
     * Optional runtime metadata used by the integration to rehydrate adapters in
     * built server runtimes where process-local state is not preserved.
     */
    __talismanAuthRuntime?: TalismanAuthRuntimeDescriptor;
}

export type { TalismanAuthAdapter as T, TalismanUser as a };
