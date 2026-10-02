import { and, eq, gt, sql, type SQL } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from '../db/client';
import * as schema from './local-schema';
import type { TalismanUser } from './types';
import { normalizeIdentityEmail } from './identity';
import type { BatchItem } from 'drizzle-orm/batch';

const PREFIX = 'cms-email-change:';
const actions = new Set(['admin/get-user-profile', 'admin/update-user-profile', 'admin/request-email-change',
  'admin/confirm-email-change', 'admin/list-user-sessions', 'admin/revoke-user-session']);
export const isProfileAction = (action: string) => actions.has(action);
const fail = (error: string, status = 400, code?: string) => Response.json({ error, ...(code && { code }) }, { status });
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
type User = typeof schema.user.$inferSelect;
const snapshot = (user: User) => ({ name: user.name, email: user.email, role: user.role, banned: user.banned, updatedAt: user.updatedAt.toISOString() });
const version = (user: User) => digest(JSON.stringify(snapshot(user)));
const unchanged = (user: User) => and(eq(schema.user.id, user.id), eq(schema.user.email, user.email),
  eq(schema.user.name, user.name), eq(schema.user.role, user.role), eq(schema.user.banned, user.banned), eq(schema.user.updatedAt, user.updatedAt))!;
const changedAt = (user: User) => new Date(Math.max(Math.floor(Date.now() / 1000), Math.floor(user.updatedAt.getTime() / 1000) + 1) * 1000);

async function send(env: TalismanEnv, to: string, subject: string, text: string) {
  const { sendConfiguredEmail } = await import('../email/runtime');
  await sendConfiguredEmail(env, { to, subject, text, kind: 'cms-email-change' });
}

/** Administrative profile actions keep the auth library's token-bearing session API private. */
export async function handleProfileAction(action: string, request: Request, env: TalismanEnv, actor: TalismanUser,
  options: { editorOnly?: boolean; currentSessionId?: string }) {
  if (actor.role !== 'admin') return fail('Admin access required', 403);
  if (request.method !== 'POST') return fail('Method not allowed', 405);
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON body required', 415);
  if (Number(request.headers.get('content-length')) > 16_384) return fail('Request body too large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) return fail('Request body too large', 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { return fail('Invalid JSON'); }
  if (!body || Array.isArray(body) || typeof body.userId !== 'string' || !body.userId || body.userId.length > 256) return fail('Choose a valid user');
  const db = createDbClient(env);
  const target = await db.select().from(schema.user).where(eq(schema.user.id, body.userId)).get();
  if (!target) return fail('User not found', 404);
  if (action === 'admin/list-user-sessions') {
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) return fail('Invalid session offset');
    const sessions = await db.select({ id: schema.session.id, createdAt: schema.session.createdAt, expiresAt: schema.session.expiresAt,
      ipAddress: schema.session.ipAddress, userAgent: schema.session.userAgent, authMethod: schema.session.authMethod })
      .from(schema.session).where(and(eq(schema.session.userId, target.id), gt(schema.session.expiresAt, new Date()),
        gt(schema.session.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))))
      .orderBy(schema.session.id).limit(51).offset(Number(offset));
    return Response.json({ sessions: sessions.slice(0, 50).map(session => ({ ...session, expiresAt: new Date(Math.min(session.expiresAt.getTime(), session.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)), current: session.id === options.currentSessionId })),
      nextOffset: sessions.length > 50 ? Number(offset) + 50 : null });
  }
  if (action === 'admin/revoke-user-session') {
    if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 256) return fail('Choose a valid session');
    await db.delete(schema.session).where(and(eq(schema.session.id, body.sessionId), eq(schema.session.userId, target.id)));
    return Response.json({ ok: true, currentSessionEnded: target.id === actor.id && body.sessionId === options.currentSessionId });
  }
  const editable = ['admin', 'editor'].includes(target.role) && !(options.editorOnly && target.role === 'admin');
  if (action === 'admin/get-user-profile') return Response.json({ user: { id: target.id, name: target.name, email: target.email }, version: await version(target), editable });
  if (!editable) return fail('This identity is managed by its sign-in provider or shopper account', 403);
  if (target.banned) return fail('Enable the account before changing its profile', 409);
  if (action !== 'admin/confirm-email-change' && (typeof body.version !== 'string' || body.version !== await version(target))) return fail('This profile changed. Reload it before saving.', 409, 'stale_record');
  if (action === 'admin/update-user-profile') {
    if (Object.keys(body).some(key => !['userId', 'version', 'name'].includes(key))) return fail('Only the profile name can be changed here');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(body.name)) return fail('Use a name between 1 and 160 characters');
    const saved = await db.update(schema.user).set({ name: body.name.trim(), updatedAt: changedAt(target) }).where(unchanged(target)).returning();
    if (!saved.length) return fail('This profile changed. Reload it before saving.', 409, 'stale_record');
    return Response.json({ ok: true, version: await version(saved[0]) });
  }
  const pendingId = PREFIX + target.id;
  if (action === 'admin/request-email-change') {
    if (typeof body.email !== 'string') return fail('Valid email required');
    const email = normalizeIdentityEmail(body.email);
    if (!email || email === target.email.toLowerCase()) return fail('Choose a different valid email address');
    if (await db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get()) return fail('That address already has an identity', 409, 'conflict');
    const previous = await db.select().from(schema.verification).where(eq(schema.verification.id, pendingId)).get();
    if (previous && previous.createdAt.getTime() > Date.now() - 60_000) return fail('Wait one minute before requesting another code', 429);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    const value = JSON.stringify({ actorId: actor.id, userId: target.id, email, original: snapshot(target), codeHash: await digest(code) });
    const now = new Date();
    await db.insert(schema.verification).values({ id: pendingId, identifier: pendingId, value, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 15 * 60_000) })
      .onConflictDoUpdate({ target: schema.verification.id, set: { value, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 15 * 60_000) } });
    try {
      await send(env, email, 'Confirm your CMS email change', `An administrator requested a change to your CMS sign-in email. Give them this confirmation code only if you approve the change:\n\n${code}\n\nThe code expires in 15 minutes. Ignore this message if you did not approve the change.`);
      await send(env, target.email, 'CMS email change requested', 'An administrator requested a change to your CMS sign-in email. Your address has not changed. The new address must be confirmed first. Contact your site administrator if you did not approve this request.');
    } catch {
      await db.delete(schema.verification).where(and(eq(schema.verification.id, pendingId), eq(schema.verification.value, value)));
      return fail('Confirmation email could not be sent. The address has not changed.', 503);
    }
    return Response.json({ ok: true, message: 'A confirmation code was sent to the new address. The current address was notified.' });
  }
  if (action === 'admin/confirm-email-change') {
    if (typeof body.code !== 'string' || !/^[a-f0-9]{48}$/.test(body.code.trim())) return fail('Enter the confirmation code from the new address');
    const pending = await db.select().from(schema.verification).where(and(eq(schema.verification.id, pendingId), gt(schema.verification.expiresAt, new Date()))).get();
    if (!pending) return fail('This code expired or was already used');
    let value: { actorId: string; email: string; original: ReturnType<typeof snapshot>; codeHash: string };
    try { value = JSON.parse(pending.value); } catch { return fail('This email change is no longer valid'); }
    if (value.actorId !== actor.id || value.codeHash !== await digest(body.code.trim())) return fail('Invalid confirmation code');
    if (JSON.stringify(value.original) !== JSON.stringify(snapshot(target))) return fail('This profile changed. Request a new code.', 409, 'stale_record');
    const pendingCondition = sql`EXISTS (SELECT 1 FROM ${schema.verification} WHERE ${schema.verification.id} = ${pendingId}
      AND ${schema.verification.value} = ${pending.value} AND ${schema.verification.expiresAt} > ${Math.floor(Date.now() / 1000)})`;
    const condition = sql`${pendingCondition} AND EXISTS (SELECT 1 FROM ${schema.user} WHERE ${unchanged(target)})`;
    let statements: SQL[] = [];
    try {
      const { identityEmailChangeHooks } = await import('virtual:talisman-cms/identity-email-change');
      for (const hook of identityEmailChangeHooks) statements.push(...await hook(env, { userId: target.id, oldEmail: target.email, newEmail: value.email, condition }));
      const queries: BatchItem<'sqlite'>[] = [
        ...statements.map(statement => db.run(statement)),
        db.delete(schema.session).where(and(eq(schema.session.userId, target.id), condition)),
        db.update(schema.user).set({ email: value.email, emailVerified: true, updatedAt: changedAt(target) }).where(and(eq(schema.user.id, target.id), condition)).returning({ id: schema.user.id }),
        db.delete(schema.verification).where(and(eq(schema.verification.id, pendingId), pendingCondition)),
      ];
      const result = await db.batch(queries as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
      if (!(result[statements.length + 1] as unknown[]).length) return fail('This profile changed. Request a new code.', 409, 'stale_record');
    } catch {
      console.error('[talisman-cms] Email change batch failed');
      return fail('The email change could not be confirmed. Reload the profile before retrying; linked accounts may need review.', 409, 'conflict');
    }
    return Response.json({ ok: true, currentSessionEnded: actor.id === target.id, message: 'Email changed. Existing CMS and linked shopper sessions were ended.' });
  }
  return fail('Unknown action', 404);
}
