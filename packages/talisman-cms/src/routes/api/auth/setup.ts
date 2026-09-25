import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { createInitialAdmin, getAccessEmail, getLocalAuthEnv } from '../../../auth/local';
import { user } from '../../../auth/local-schema';
import { readSetting } from '../../../env';
import { eq, sql } from 'drizzle-orm';
import { adminPath } from 'virtual:talisman-cms/config';
import { authAdapter } from 'virtual:talisman-cms/auth';

async function setupState(request: Request) {
  if (authAdapter?.__talismanAuthRuntime?.moduleId !== 'talisman-cms/auth/local') {
    return { response: Response.json({ error: 'Local authentication is not configured' }, { status: 404 }) };
  }
  const env = await getLocalAuthEnv();
  const accessEmail = await getAccessEmail(request, env);
  if (accessEmail === null) {
    return { response: Response.json({ error: 'Cloudflare Access authorization required' }, { status: 403 }) };
  }
  if (!env.DB) return { response: Response.json({ error: 'DB binding is missing' }, { status: 503 }) };
  const existing = await drizzle(env.DB).select({ id: user.id }).from(user).where(eq(user.role, 'admin')).limit(1);
  return { env, accessEmail, required: existing.length === 0 };
}

export const GET: APIRoute = async ({ request }) => {
  const state = await setupState(request);
  if ('response' in state) return state.response!;
  return Response.json({ required: state.required }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  }
  const state = await setupState(request);
  if ('response' in state) return state.response!;
  if (!state.required) return Response.json({ error: 'Setup is already complete' }, { status: 409 });

  const expected = readSetting(state.env, 'AUTH_SETUP_TOKEN');
  const supplied = request.headers.get('x-talisman-setup-token') || '';
  if (typeof expected !== 'string' || expected.length < 32 || supplied.length !== expected.length) {
    return Response.json({ error: 'Invalid setup token' }, { status: 403 });
  }
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(supplied);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  if (difference !== 0) return Response.json({ error: 'Invalid setup token' }, { status: 403 });

  const body = await request.json().catch(() => null) as { email?: unknown; name?: unknown; password?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || password.length < 12 || password.length > 128) {
    return Response.json({ error: 'Provide a name, valid email, and password of 12–128 characters' }, { status: 400 });
  }
  if (state.accessEmail !== undefined && state.accessEmail !== email) {
    return Response.json({ error: 'Account must match Cloudflare Access identity' }, { status: 403 });
  }

  // Shoppers share the account table, so the email may already belong to a customer identity.
  const existingAccount = () => drizzle(state.env!.DB).select({ role: user.role }).from(user)
    .where(sql`lower(${user.email}) = ${email}`).limit(1).then(rows => rows[0]);
  const conflict = (account: { role: string | null }) => Response.json({
    error: account.role === 'customer'
      ? 'This email belongs to a shopper account. Use a different email for the first admin.'
      : 'This email already has an account. Use a different email for the first admin.',
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  const existing = await existingAccount();
  if (existing) return conflict(existing);

  try {
    await createInitialAdmin(request, state.env!, adminPath, { email, name, password });
  } catch (error) {
    // A shopper sign-in or another setup request can claim the email between the check above and the insert.
    const claimed = await existingAccount();
    if (claimed) return conflict(claimed);
    throw error;
  }
  return Response.json({ created: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
};
