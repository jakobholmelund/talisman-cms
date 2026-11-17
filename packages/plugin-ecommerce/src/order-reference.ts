/** A readable display/search reference. Ownership and mutations always use the full order ID. */
export function orderReference(id: string): string {
  const suffix = id.match(/-([0-9a-f]{12})$/i)?.[1];
  return suffix ? `TAL-${suffix.toUpperCase()}` : id;
}

/** Only a bounded order identifier can cross the email sign-in handoff; never an arbitrary URL. */
export function customerOrderDestination(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function customerOrderPath(id: string) {
  return `/checkout/success?order=${encodeURIComponent(id)}`;
}
