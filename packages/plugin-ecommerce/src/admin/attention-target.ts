import { useLocation } from '@tanstack/react-router';

type Target = { kind: 'request' | 'inspection' | 'refund' | 'recovery' | 'order'; id: string; orderId: string };
const identifier = (value: string | null): value is string => !!value && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Only record references travel in the fragment, which is not sent in HTTP requests. The
 * destination still reads fresh details through its protected API; this is never write authority. */
export function attentionTarget(hash: string): Target | null {
  if (hash.length > 500) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (['kind', 'id', 'orderId'].some(key => params.getAll(key).length > 1)) return null;
  const kind = params.get('kind'), id = params.get('id'), orderId = params.get('orderId');
  if (!['request', 'inspection', 'refund', 'recovery', 'order'].includes(kind ?? '') || !identifier(id)) return null;
  if (kind === 'inspection' && !identifier(orderId)) return null;
  return { kind: kind as Target['kind'], id, orderId: identifier(orderId) ? orderId : '' };
}

export function useAttentionTarget() {
  const hash = useLocation({ select: location => location.hash });
  return { hash, target: attentionTarget(hash) };
}
