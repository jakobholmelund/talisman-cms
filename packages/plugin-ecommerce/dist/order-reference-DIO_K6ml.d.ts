/** A readable display/search reference. Ownership and mutations always use the full order ID. */
declare function orderReference(id: string): string;
/** Only a bounded order identifier can cross the email sign-in handoff; never an arbitrary URL. */
declare function customerOrderDestination(value: unknown): string | null;
declare function customerOrderPath(id: string): string;

export { customerOrderPath as a, customerOrderDestination as c, orderReference as o };
