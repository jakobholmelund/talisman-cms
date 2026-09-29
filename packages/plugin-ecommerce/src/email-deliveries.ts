import { and, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, type CommerceDb } from './db';
import { isEmailDeliveryError, parseAddress, resolveEmailProvider, sendEmail, type EmailProvider } from 'talisman-cms/email';
import { readSetting } from 'talisman-cms/env';
import { emailLink, type CommerceEmailMessage, type CommerceEmailStore, type CommerceEmailTemplates } from './emails';
import { emailDeliveries } from './schema';

/**
 * Order confirmations, shipment notices and gift card claim emails go through `_ecommerce_email_deliveries`.
 * The change that calls for an email writes its row in the same batch
 * (`commerceEmailStatement`), so duplicate webhooks and the reconciliation path find one row. The email
 * is sent right after the batch commits and retried by the scheduled job until it is sent, given up
 * after COMMERCE_EMAIL_MAX_ATTEMPTS, or older than COMMERCE_EMAIL_MAX_AGE_SECONDS. A failed send never
 * fails the payment, shipment or webhook that asked for it. Rows, results and logs carry ids and error
 * codes only, never an address.
 */
export type CommerceEmailKind = 'order_confirmation' | 'shipment' | 'shipment_update' | 'gift_card_claim';

/** Sends per email before it is given up; the waits between them add up to about two days. */
export const COMMERCE_EMAIL_MAX_ATTEMPTS = 10;
/** An email not sent within this time, for example because email was not configured, is given up. */
export const COMMERCE_EMAIL_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** How long a Worker may take to send an email it claimed before another Worker may take it over. */
export const COMMERCE_EMAIL_LEASE_SECONDS = 5 * 60;
const FIRST_RETRY_SECONDS = 10 * 60;
const LONGEST_RETRY_SECONDS = 12 * 60 * 60;

/** The wait after the given number of attempts: 10 minutes, doubling up to 12 hours. */
export function commerceEmailRetryDelay(attempts: number) {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), LONGEST_RETRY_SECONDS);
}

/** The `X-Talisman-Email` header of each kind, so delivery logs can be filtered. */
const KIND_HEADERS: Record<CommerceEmailKind, string> = {
  order_confirmation: 'order-confirmation',
  shipment: 'order-shipment',
  shipment_update: 'order-shipment-update',
  gift_card_claim: 'gift-card-claim',
};

const KIND_LABELS: Record<CommerceEmailKind, string> = {
  order_confirmation: 'Order confirmation email',
  shipment: 'Shipment email',
  shipment_update: 'Shipment update email',
  gift_card_claim: 'Gift card claim email',
};

/** Failures an operator has to fix: every email fails the same way until they do. */
const CONFIGURATION_ERRORS = new Set(['not_configured', 'sender_rejected', 'invalid_message']);

export interface CommerceEmailSetup {
  provider: EmailProvider | null;
  /** `TALISMAN_COMMERCE_EMAIL_FROM`, else `TALISMAN_EMAIL_FROM`. */
  from: string | null;
  /** The support address when `TALISMAN_COMMERCE_SUPPORT_EMAIL` sets one; otherwise `TALISMAN_EMAIL_REPLY_TO` applies. */
  replyTo: string | null;
  store: CommerceEmailStore;
  templates: CommerceEmailTemplates | null;
}

/** An email to send, or why it is no longer sent: `cancel` when it is no longer due, `fail` when it cannot be delivered. */
export type CommerceEmailComposition =
  | { to: string; message: CommerceEmailMessage; onFailure?: () => Promise<unknown> }
  | { cancel: string }
  | { fail: string };

/**
 * Reads what an email needs at send time and builds it. `now` is also the stamp of the calling Worker's
 * claim on the email, for writes that must happen only while that Worker holds it (commerceEmailHeld).
 */
export type CommerceEmailComposer = (env: TalismanEnv, subjectId: string, setup: CommerceEmailSetup, now: number)
  => Promise<CommerceEmailComposition>;

/** `id` is `<kind>:<subject id>`; `error` is a code or a sentence without addresses. */
export type CommerceEmailResult = { id: string; status: string; error?: string };

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);
/** The email of this kind and subject, while it is still pending. */
const pendingEmail = (kind: CommerceEmailKind, subjectId: string) => and(eq(emailDeliveries.kind, kind),
  eq(emailDeliveries.subjectId, subjectId), eq(emailDeliveries.status, 'pending'));
/** No Worker holds the email, or the lease it took had run out at `now`. */
export const unclaimedAt = (now: number) => or(isNull(emailDeliveries.claimedAt),
  lte(emailDeliveries.claimedAt, at(now - COMMERCE_EMAIL_LEASE_SECONDS)));

function originOf(value: string | undefined) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[commerce] ${message}`);
}

/** A link setting as an absolute URL: an https URL, or a path on the public origin. */
function storeLink(env: Record<string, unknown>, name: string, origin: string | null) {
  const value = readSetting(env, name);
  if (!value) return null;
  let link: string | null = null;
  try {
    link = emailLink(new URL(value, origin ?? undefined).href);
  } catch {
    link = null;
  }
  if (!link) warnOnce(`TALISMAN_${name} must be an https URL or a path on the public origin; emails leave it out`);
  return link;
}

/** A bare address, checked like a recipient; a display name is never accepted. */
export function bareEmailAddress(value: unknown) {
  if (typeof value !== 'string') return null;
  return parseAddress({ email: value.trim() })?.email ?? null;
}

let emailRuntime: Promise<{ getEmailProvider(env: Record<string, unknown>): EmailProvider | null } | null> | undefined;
let storeTemplates: Promise<CommerceEmailTemplates | null> | undefined;

// Both modules are loaded when an email is sent, not when this module is imported: they read virtual
// modules that only a site build provides. Outside a build, for example in node tests, email still
// goes through the send_email binding or the console provider, and the default templates are used.
async function configuredEmailProvider(env: Record<string, unknown>) {
  emailRuntime ??= import('talisman-cms/email/runtime').catch(() => null);
  const runtime = await emailRuntime;
  return runtime ? runtime.getEmailProvider(env) : resolveEmailProvider(env);
}

function configuredTemplates() {
  storeTemplates ??= import('virtual:talisman-cms/ecommerce-emails')
    .then((module) => (module.emailTemplates ?? null) as CommerceEmailTemplates | null)
    .catch((error) => {
      const code = (error as { code?: unknown } | null)?.code;
      // A site build always provides the module, so there a failure means the store's module threw.
      if (code !== 'ERR_UNSUPPORTED_ESM_URL_SCHEME' && code !== 'ERR_MODULE_NOT_FOUND') {
        console.error('[commerce] Store email templates could not be loaded; the default templates are used',
          { name: error instanceof Error ? error.name : typeof error });
      }
      return null;
    });
  return storeTemplates;
}

/** The provider, sender, store details and templates for commerce emails, read from the Worker settings. */
export async function commerceEmailSetup(env: TalismanEnv): Promise<CommerceEmailSetup> {
  const settings = env as unknown as Record<string, unknown>;
  const from = readSetting(settings, 'COMMERCE_EMAIL_FROM') ?? readSetting(settings, 'EMAIL_FROM') ?? null;
  const origin = originOf(readSetting(settings, 'COMMERCE_PUBLIC_ORIGIN') ?? readSetting(settings, 'PUBLIC_ORIGIN'));
  const supportSetting = readSetting(settings, 'COMMERCE_SUPPORT_EMAIL');
  const support = bareEmailAddress(supportSetting);
  if (supportSetting && !support) warnOnce('TALISMAN_COMMERCE_SUPPORT_EMAIL must be a bare email address; emails leave it out');
  const replyTo = parseAddress(readSetting(settings, 'EMAIL_REPLY_TO') ?? '')?.email ?? null;
  let provider: EmailProvider | null = null;
  try {
    provider = await configuredEmailProvider(settings);
  } catch (error) {
    console.error('[commerce] The email provider could not be created', { name: error instanceof Error ? error.name : typeof error });
  }
  return {
    provider,
    from,
    replyTo: support,
    store: {
      name: readSetting(settings, 'COMMERCE_STORE_NAME') ?? (from ? parseAddress(from)?.name : undefined)
        ?? (origin ? new URL(origin).host : 'Our store'),
      legalName: readSetting(settings, 'COMMERCE_STORE_LEGAL_NAME') ?? null,
      address: (readSetting(settings, 'COMMERCE_STORE_ADDRESS') ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      supportEmail: support ?? replyTo,
      termsUrl: storeLink(settings, 'COMMERCE_TERMS_URL', origin),
      returnsUrl: storeLink(settings, 'COMMERCE_RETURNS_URL', origin),
      warrantyUrl: storeLink(settings, 'COMMERCE_WARRANTY_URL', origin),
      origin,
    },
    templates: await configuredTemplates(),
  };
}

/** The settings an email of this kind still needs; empty when it can be sent. */
export function missingEmailSettings(setup: CommerceEmailSetup, kind: CommerceEmailKind) {
  return [
    ...(setup.provider ? [] : ['an email provider']),
    ...(setup.from && parseAddress(setup.from) ? [] : ['a sender (TALISMAN_EMAIL_FROM)']),
    // A claim link points at the storefront, and a link in an email must be https (http only on
    // localhost); without one the email would go out without the link it exists for.
    ...(kind !== 'gift_card_claim' || (setup.store.origin && emailLink(setup.store.origin))
      ? [] : ['an https public origin (TALISMAN_PUBLIC_ORIGIN)']),
  ];
}

/** One result for the due emails that wait for settings, instead of one per email. */
export function waitingEmailsResult(kinds: CommerceEmailKind[] | 'all', missing: string[], waiting: number,
  limit: number): CommerceEmailResult {
  const what = kinds === 'all' ? 'Email needs' : `${kinds.map((kind) => `${KIND_LABELS[kind]}s`).join(' and ')} need`;
  const count = `${waiting}${waiting === limit ? ' or more' : ''} email${waiting === 1 ? ' is' : 's are'} waiting`;
  return { id: 'commerce_emails', status: 'error', error: `${what} ${missing.join(', ')}; ${count}` };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validMessage(value: unknown): value is CommerceEmailMessage {
  const message = value as CommerceEmailMessage | null;
  return Boolean(message) && typeof message!.subject === 'string' && Boolean(message!.subject.trim())
    && message!.subject.length <= 998 && !CONTROL_CHARACTERS.test(message!.subject)
    && typeof message!.text === 'string' && Boolean(message!.text.trim())
    && (message!.html === undefined || typeof message!.html === 'string');
}

/** The store's template for this email when it has one that works; otherwise the default. */
export async function applyEmailTemplate<T>(setup: CommerceEmailSetup, name: keyof CommerceEmailTemplates, email: T,
  defaults: CommerceEmailMessage): Promise<CommerceEmailMessage> {
  const template = setup.templates?.[name] as ((email: T, defaults: CommerceEmailMessage) => unknown) | undefined;
  if (typeof template !== 'function') return defaults;
  try {
    const message = await template(email, defaults);
    if (validMessage(message)) {
      return { subject: message.subject, text: message.text, ...(message.html === undefined ? {} : { html: message.html }) };
    }
    console.error('[commerce] A store email template returned no valid message; the default is sent', { template: name });
  } catch (error) {
    console.error('[commerce] A store email template failed; the default is sent',
      { template: name, name: error instanceof Error ? error.name : typeof error });
  }
  return defaults;
}

/**
 * The statement that asks for an email; add it to the batch that makes the email due. `condition` is
 * an SQL expression that must hold for the row to be written. A row for the same kind and subject is
 * never written twice.
 */
export function commerceEmailStatement(kind: CommerceEmailKind, subjectId: string, now: number, condition?: SQL): SQL {
  return sql`INSERT INTO _ecommerce_email_deliveries (id, kind, subject_id, next_attempt_at, created_at)
    SELECT ${`mail_${crypto.randomUUID()}`}, ${kind}, ${subjectId}, ${now}, ${now} WHERE ${condition ?? sql`1`}
    ON CONFLICT (kind, subject_id) DO NOTHING`;
}

/** The condition, for a write that must happen only while the claim stamped `stamp` still holds the email. */
export function commerceEmailHeld(kind: CommerceEmailKind, subjectId: string, stamp: number): SQL {
  return sql`EXISTS (SELECT 1 FROM _ecommerce_email_deliveries
    WHERE kind = ${kind} AND subject_id = ${subjectId} AND status = 'pending' AND claimed_at = ${stamp})`;
}

/**
 * Holds a pending email while an administrator acts on its subject, with the lease a sending Worker
 * takes, so the scheduled job leaves it alone meanwhile. Counts no attempt. Returns the hold's stamp,
 * null when no email of this kind and subject is pending, or 'busy' while a Worker is sending it.
 */
export async function holdCommerceEmail(env: TalismanEnv, kind: CommerceEmailKind, subjectId: string, now: number) {
  const db = commerceDb(env);
  const [held] = await db.update(emailDeliveries).set({ claimedAt: at(now) })
    .where(and(pendingEmail(kind, subjectId), unclaimedAt(now))).returning({ id: emailDeliveries.id });
  if (held) return now;
  const pending = await db.select({ id: emailDeliveries.id }).from(emailDeliveries)
    .where(pendingEmail(kind, subjectId)).get();
  return pending ? 'busy' as const : null;
}

/** The email of this kind and subject while the hold stamped `stamp` still holds it. */
const heldBy = (kind: CommerceEmailKind, subjectId: string, stamp: number) =>
  and(pendingEmail(kind, subjectId), eq(emailDeliveries.claimedAt, at(stamp)));

/** Ends a hold and leaves the email as it was, still waiting for its next attempt. A batch item. */
export function releaseCommerceEmailStatement(db: CommerceDb, kind: CommerceEmailKind, subjectId: string, stamp: number) {
  return db.update(emailDeliveries).set({ claimedAt: null }).where(heldBy(kind, subjectId, stamp));
}

/** Ends a hold by cancelling the email: another message sent in its place made it unnecessary. A batch item. */
export function supersedeCommerceEmailStatement(db: CommerceDb, kind: CommerceEmailKind, subjectId: string, stamp: number) {
  return db.update(emailDeliveries).set({ status: 'cancelled', lastError: 'superseded', claimedAt: null })
    .where(heldBy(kind, subjectId, stamp));
}

/** Sends a composed email from the store's sender, with the support address as Reply-To when one is set. */
export function sendCommerceMessage(env: TalismanEnv, setup: CommerceEmailSetup, kind: CommerceEmailKind, to: string,
  message: CommerceEmailMessage) {
  // The object form keeps the recipient a bare address; a display name can never change it.
  return sendEmail(env as unknown as Record<string, unknown>, { to: { email: to }, from: setup.from ?? undefined,
    ...(setup.replyTo ? { replyTo: setup.replyTo } : {}), subject: message.subject, text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }), kind: KIND_HEADERS[kind] }, setup.provider);
}

/** The error code of a failed send. */
export function emailErrorCode(error: unknown) {
  return isEmailDeliveryError(error) ? error.code : 'unknown';
}

/**
 * Sends one email of `_ecommerce_email_deliveries` when it is due: claims it with a lease, builds it
 * with `compose`, sends it and records the outcome. Returns null when there is nothing to do (it was
 * sent or given up, is not due yet, or another Worker is sending it) and when this Worker's lease ran
 * out and another Worker took the email over. Never throws.
 */
export async function runCommerceEmailDelivery(env: TalismanEnv, kind: CommerceEmailKind, subjectId: string,
  compose: CommerceEmailComposer, options: { setup?: CommerceEmailSetup; now?: number } = {}): Promise<CommerceEmailResult | null> {
  const id = `${kind}:${subjectId}`;
  const label = KIND_LABELS[kind];
  try {
    const now = options.now ?? nowSeconds();
    const setup = options.setup ?? await commerceEmailSetup(env);
    const missing = missingEmailSettings(setup, kind);
    const db = commerceDb(env);
    if (missing.length) {
      // Nothing is claimed or counted: the email waits until email is configured, up to its maximum age.
      await db.update(emailDeliveries).set({ lastError: 'not_configured' }).where(pendingEmail(kind, subjectId));
      return { id, status: 'error', error: `${label} waits: email needs ${missing.join(', ')}` };
    }
    const [claimed] = await db.update(emailDeliveries)
      .set({ claimedAt: at(now), attempts: sql`${emailDeliveries.attempts} + 1` })
      .where(and(pendingEmail(kind, subjectId), lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now)))
      .returning({ id: emailDeliveries.id, attempts: emailDeliveries.attempts });
    if (!claimed) return null;
    // Only the Worker holding the claim records the outcome; one whose lease was taken over records
    // nothing and reports nothing, since the Worker that holds the email now does both.
    type Outcome = Partial<Pick<typeof emailDeliveries.$inferInsert, 'status' | 'lastError' | 'nextAttemptAt' | 'sentAt'>>;
    const settle = async (outcome: Outcome) => {
      const { meta } = await db.update(emailDeliveries).set({ ...outcome, claimedAt: null })
        .where(and(eq(emailDeliveries.id, claimed.id), eq(emailDeliveries.claimedAt, at(now)))).run();
      return Number(meta?.changes ?? 0) > 0;
    };
    const recordFailure = async (code: string): Promise<CommerceEmailResult | null> => {
      // A suppressed address stays suppressed; anything else may pass on a later attempt.
      if (code === 'recipient_suppressed') {
        return await settle({ status: 'failed', lastError: code }) ? { id, status: 'email_undeliverable', error: code } : null;
      }
      if (claimed.attempts >= COMMERCE_EMAIL_MAX_ATTEMPTS) {
        return await settle({ status: 'failed', lastError: code })
          ? { id, status: 'error', error: `${label} was given up after ${claimed.attempts} attempts (${code})` } : null;
      }
      if (!await settle({ lastError: code, nextAttemptAt: at(now + commerceEmailRetryDelay(claimed.attempts)) })) return null;
      return CONFIGURATION_ERRORS.has(code)
        ? { id, status: 'error', error: `${label} could not be sent (${code}); it is retried` }
        : { id, status: 'email_retry', error: code };
    };

    let composed: CommerceEmailComposition;
    try {
      composed = await compose(env, subjectId, setup, now);
    } catch (error) {
      console.error('[commerce] An email could not be built', { kind, name: error instanceof Error ? error.name : typeof error });
      return await recordFailure('compose_failed');
    }
    if ('cancel' in composed) {
      return await settle({ status: 'cancelled', lastError: composed.cancel })
        ? { id, status: 'email_cancelled', error: composed.cancel } : null;
    }
    if ('fail' in composed) {
      return await settle({ status: 'failed', lastError: composed.fail })
        ? { id, status: 'email_undeliverable', error: composed.fail } : null;
    }
    try {
      await sendCommerceMessage(env, setup, kind, composed.to, composed.message);
    } catch (error) {
      await composed.onFailure?.().catch(() => undefined);
      return await recordFailure(emailErrorCode(error));
    }
    // The email went out, so this is reported even when a Worker took it over after the lease ran out.
    await settle({ status: 'sent', sentAt: at(now), lastError: null });
    return { id, status: 'email_sent' };
  } catch (error) {
    return { id, status: 'error', error: `${label} could not be recorded (${error instanceof Error ? error.name : 'error'})` };
  }
}

/**
 * Sends an email right after the change that asked for it committed, and logs a failure with ids and
 * codes only. The scheduled job retries what this could not send. Never throws.
 */
export async function sendCommerceEmailNow(env: TalismanEnv, kind: CommerceEmailKind, subjectId: string,
  compose: CommerceEmailComposer) {
  const result = await runCommerceEmailDelivery(env, kind, subjectId, compose);
  if (!result || result.status === 'email_sent') return result;
  const details = { kind, subject: subjectId, status: result.status, error: result.error };
  if (result.status === 'error') console.error('[commerce] Email not sent', details);
  else console.warn('[commerce] Email not sent', details);
  return result;
}
