import { readSetting } from '../env';
import { cloudflareEmailProvider, isSendEmailBinding } from './cloudflare';
import { consoleEmailProvider } from './console';
import { EmailDeliveryError, isEmailDeliveryError } from './types';
import type {
  EmailAddressInput,
  EmailMessage,
  EmailProvider,
  EmailProviderFactory,
  EmailRuntimeDescriptor,
  EmailSendResult,
  ParsedAddress,
  ResolvedEmailMessage,
} from './types';

export type {
  EmailAddressInput,
  EmailErrorCode,
  EmailMessage,
  EmailProvider,
  EmailProviderFactory,
  EmailRuntimeDescriptor,
  EmailSendResult,
  ParsedAddress,
  ResolvedEmailMessage,
  SendEmailBindingLike,
} from './types';
export { EmailDeliveryError, isEmailDeliveryError } from './types';
export { cloudflareEmailProvider } from './cloudflare';
export { consoleEmailProvider } from './console';
export { escapeHtml, renderTransactionalEmail } from './template';
export type { TransactionalEmailContent } from './template';

/** Values of the `TALISMAN_EMAIL_PROVIDER` setting. */
export const EMAIL_PROVIDERS = ['cloudflare', 'console', 'custom', 'none'] as const;
export type EmailProviderSetting = typeof EMAIL_PROVIDERS[number];

// Bindings that also have send() or that the CMS uses for something else.
const NOT_EMAIL_BINDINGS = new Set(['DB', 'KV', 'SESSION', 'QUEUE', 'STORAGE', 'IMAGES', 'AI', 'ASSETS']);
const WARNINGS_KEY = '__TALISMAN_CMS_EMAIL_WARNINGS__';

// Configuration problems are logged once per isolate; the caller still sees a missing provider.
function warnOnce(message: string) {
  const runtime = globalThis as typeof globalThis & { [WARNINGS_KEY]?: Set<string> };
  const warned = runtime[WARNINGS_KEY] ??= new Set();
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[Talisman CMS] ${message}`);
}

/**
 * The provider for this request, chosen by `TALISMAN_EMAIL_PROVIDER`:
 * - `cloudflare`: the `[[send_email]]` binding named by `TALISMAN_EMAIL_BINDING` (default `EMAIL`).
 * - `console`: logs messages instead of sending them; only when `TALISMAN_PUBLIC_ORIGIN` is on localhost.
 * - `custom`: the provider registered with `talismanCms({ email })`.
 * - `none`: email is off.
 * When the setting is unset, a registered custom provider wins, then a binding named `EMAIL`.
 * Returns null when nothing is configured.
 */
export function resolveEmailProvider(env: Record<string, unknown>, configured: EmailProviderFactory | null = null): EmailProvider | null {
  const raw = readSetting(env, 'EMAIL_PROVIDER');
  const choice = raw?.toLowerCase();
  if (choice && !(EMAIL_PROVIDERS as readonly string[]).includes(choice)) {
    warnOnce(`TALISMAN_EMAIL_PROVIDER "${raw!.slice(0, 32)}" is not one of ${EMAIL_PROVIDERS.join(', ')}; email is off.`);
    return null;
  }
  if (choice === 'none') return null;
  if (choice === 'custom' || (!choice && configured)) {
    if (typeof configured !== 'function') {
      warnOnce(choice === 'custom'
        ? 'TALISMAN_EMAIL_PROVIDER is custom, but talismanCms({ email }) registers no provider; email is off.'
        : 'The talismanCms({ email }) provider must return a function that builds the provider from the Worker env; email is off.');
      return null;
    }
    return configured(env);
  }
  if (choice === 'console') {
    const provider = consoleEmailProvider(env);
    if (!provider) warnOnce('The console email provider runs only when TALISMAN_PUBLIC_ORIGIN is a localhost origin; email is off.');
    return provider;
  }
  const bindingName = readSetting(env, 'EMAIL_BINDING') ?? 'EMAIL';
  if (NOT_EMAIL_BINDINGS.has(bindingName)) {
    warnOnce(`TALISMAN_EMAIL_BINDING must name a [[send_email]] binding, not ${bindingName}; email is off.`);
    return null;
  }
  const binding = env[bindingName];
  if (isSendEmailBinding(binding)) return cloudflareEmailProvider(binding);
  if (choice === 'cloudflare') {
    warnOnce(`TALISMAN_EMAIL_PROVIDER is cloudflare, but the Worker has no [[send_email]] binding named ${bindingName}; email is off.`);
  }
  return null;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// Characters that are only valid inside a quoted local part. Such addresses are not accepted.
const EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(?:\.[^\s@<>()[\]\\,;:".]+)+$/;
const NAMED_ADDRESS = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<>"]*?))\s*<([^<>]*)>\s*$/;

function checkedAddress(email: unknown, name?: unknown): ParsedAddress | null {
  if (typeof email !== 'string') return null;
  const address = email.trim();
  if (address.length > 254 || !EMAIL_ADDRESS.test(address)) return null;
  if (name === undefined || name === null || name === '') return { email: address };
  if (typeof name !== 'string' || name.length > 256 || CONTROL_CHARACTERS.test(name)) return null;
  const display = name.trim();
  return display ? { email: address, name: display } : { email: address };
}

/**
 * Parses `a@example.com`, `Name <a@example.com>`, `"Name, Inc." <a@example.com>` or `{ email, name }`.
 * Returns null for anything else, including line breaks or other control characters.
 */
export function parseAddress(value: EmailAddressInput): ParsedAddress | null {
  if (typeof value === 'object' && value !== null) return checkedAddress(value.email, value.name);
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return null;
  const named = value.match(NAMED_ADDRESS);
  if (!named) return checkedAddress(value);
  const name = named[1] !== undefined ? named[1].replace(/\\(.)/g, '$1') : named[2];
  return checkedAddress(named[3], name);
}

const MAX_RECIPIENTS = 50;
const HEADER_NAME = /^X-[A-Za-z0-9_-]{1,98}$/;
const EMAIL_KIND = /^[a-z0-9-]{1,64}$/;
const HEADER_VALUE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function invalid(provider: string, message: string) {
  return new EmailDeliveryError('invalid_message', message, provider);
}

function resolveMessage(env: Record<string, unknown>, message: EmailMessage, provider: string): ResolvedEmailMessage {
  const fromInput = message.from ?? readSetting(env, 'EMAIL_FROM');
  if (!fromInput) throw new EmailDeliveryError('not_configured', 'No sender address is configured; set TALISMAN_EMAIL_FROM', provider);
  const from = parseAddress(fromInput);
  if (!from) throw invalid(provider, 'The sender address is invalid');
  const replyToInput = message.replyTo ?? readSetting(env, 'EMAIL_REPLY_TO');
  const replyTo = replyToInput ? parseAddress(replyToInput) : undefined;
  if (replyTo === null) throw invalid(provider, 'The Reply-To address is invalid');

  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw invalid(provider, `A message needs 1 to ${MAX_RECIPIENTS} recipients`);
  const to = recipients.map(parseAddress);
  if (to.some((address) => !address)) throw invalid(provider, 'A recipient address is invalid');

  if (typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 998 || CONTROL_CHARACTERS.test(message.subject)) {
    throw invalid(provider, 'The subject must be one line of 1 to 998 characters');
  }
  if (typeof message.text !== 'string' || !message.text.trim()) throw invalid(provider, 'A plain-text part is required');
  if (message.html !== undefined && typeof message.html !== 'string') throw invalid(provider, 'The HTML part must be a string');
  if (message.kind !== undefined && (typeof message.kind !== 'string' || !EMAIL_KIND.test(message.kind))) {
    throw invalid(provider, 'The email kind must use lowercase letters, digits and hyphens');
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw invalid(provider, 'Custom headers must be X- headers');
    if (typeof value !== 'string' || HEADER_VALUE_CONTROL.test(value) || new TextEncoder().encode(value).byteLength > 2048) {
      throw invalid(provider, 'Header values must be one line of at most 2,048 bytes');
    }
    headers[name] = value;
  }
  if (message.kind) headers['X-Talisman-Email'] = message.kind;
  // Asks vacation responders and other automated mail not to reply to the Reply-To address.
  headers['Auto-Submitted'] = 'auto-generated';

  return {
    to: to as ParsedAddress[],
    from,
    ...(replyTo ? { replyTo } : {}),
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    headers,
    ...(message.kind ? { kind: message.kind } : {}),
  };
}

/**
 * Validates the message and sends it through `provider`. From and Reply-To default to the
 * `TALISMAN_EMAIL_FROM` and `TALISMAN_EMAIL_REPLY_TO` settings. Every failure is an
 * `EmailDeliveryError` whose message contains no addresses or content.
 */
export async function sendEmail(env: Record<string, unknown>, message: EmailMessage, provider: EmailProvider | null): Promise<EmailSendResult> {
  if (!provider) throw new EmailDeliveryError('not_configured', 'No email provider is configured', 'none');
  const resolved = resolveMessage(env, message, provider.id);
  try {
    return await provider.send(resolved);
  } catch (error) {
    if (isEmailDeliveryError(error)) throw error;
    throw new EmailDeliveryError('unknown', `Email provider ${provider.id} failed`, provider.id, undefined, { cause: error });
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Common API key and signing secret prefixes. Descriptor arguments are written into the build.
const SECRET_LIKE = /^(?:re_|sk_|rk_|whsec_|xkeysib-|SG\.)/;

function checkDescriptorArgument(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
  } else if (typeof value === 'string') {
    if (!SECRET_LIKE.test(value)) return;
    throw new TypeError(`[talisman-cms] email ${path} looks like a secret. Arguments are written into the build; pass the name of a Worker secret instead.`);
  } else if (Array.isArray(value)) {
    return value.forEach((item, index) => checkDescriptorArgument(item, `${path}[${index}]`));
  } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value as Record<string, unknown>).forEach(([key, item]) => checkDescriptorArgument(item, `${path}.${key}`));
  }
  throw new TypeError(`[talisman-cms] email ${path} must be JSON: null, a boolean, a finite number, a string, an array or a plain object.`);
}

/**
 * Registers a custom email provider with `talismanCms({ email: customEmail({ ... }) })`. The Worker
 * imports `exportName` from `moduleId` and calls it with `args` once; the result must be an
 * `EmailProviderFactory`. `args` are written into the build, so pass setting names, never secrets.
 */
export function customEmail(descriptor: EmailRuntimeDescriptor): EmailRuntimeDescriptor {
  const { moduleId, exportName, args = [] } = descriptor ?? {} as EmailRuntimeDescriptor;
  if (typeof moduleId !== 'string' || !moduleId.trim()) {
    throw new TypeError('[talisman-cms] email.moduleId must be a package specifier or an absolute path.');
  }
  if (typeof exportName !== 'string' || !IDENTIFIER.test(exportName)) {
    throw new TypeError('[talisman-cms] email.exportName must name a named export of email.moduleId.');
  }
  if (!Array.isArray(args)) throw new TypeError('[talisman-cms] email.args must be an array.');
  checkDescriptorArgument(args, 'args');
  return { moduleId, exportName, args };
}

/** Source of `virtual:talisman-cms/email`, which `talisman-cms/email/runtime` reads in the Worker. */
export function buildEmailVirtualModule(email?: EmailRuntimeDescriptor | null) {
  if (!email) return 'export const emailProviderFactory = null;\n';
  const { moduleId, exportName, args } = customEmail(email);
  return [
    `import { ${exportName} as __talismanCmsEmailProvider } from ${JSON.stringify(moduleId)};`,
    `export const emailProviderFactory = __talismanCmsEmailProvider(...${JSON.stringify(args)});`,
    '',
  ].join('\n');
}
