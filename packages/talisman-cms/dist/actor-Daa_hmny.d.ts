import { a as TalismanUser } from './types-C5a-hx5D.js';

/**
 * Who is calling the service. A `user` is the admin API's signed-in editor or administrator, and
 * the authorization rules apply to it. `system` is server code that already holds the bindings
 * (the SDK's default), which the rules cannot lock out. `plugin` is reserved for Plugin API v2 and
 * is treated like `system` until then.
 */
type Actor = {
    kind: 'user';
    user: TalismanUser;
    request: Request;
} | {
    kind: 'system';
    label?: string;
    request?: Request;
} | {
    kind: 'plugin';
    plugin: string;
    user?: TalismanUser;
    request?: Request;
};
declare const systemActor: (label?: string) => Actor;
declare const userActor: (user: TalismanUser, request: Request) => Actor;

export { type Actor as A, systemActor as s, userActor as u };
