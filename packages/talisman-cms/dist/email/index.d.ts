import { S as SendEmailBindingLike, a as EmailProvider, E as EmailRuntimeDescriptor, d as EmailAddressInput, P as ParsedAddress, e as EmailProviderFactory, b as EmailMessage, c as EmailSendResult } from '../types-CqOBvOgc.js';
export { f as EmailDeliveryError, g as EmailErrorCode, R as ResolvedEmailMessage, i as isEmailDeliveryError } from '../types-CqOBvOgc.js';

/** Sends through a Cloudflare Email Service `[[send_email]]` binding. */
declare function cloudflareEmailProvider(binding: SendEmailBindingLike): EmailProvider;

/**
 * Development only: writes each message, links included, to the Worker log instead of sending it.
 * Returns null unless `TALISMAN_PUBLIC_ORIGIN` is a localhost origin, so it cannot run in production.
 */
declare function consoleEmailProvider(env: Record<string, unknown>): EmailProvider | null;

declare function escapeHtml(value: string): string;
interface TransactionalEmailContent {
    siteName: string;
    heading: string;
    paragraphs: string[];
    action?: {
        label: string;
        url: string;
    };
    footer?: string;
}
/**
 * A plain-text part and a minimal inline-styled HTML part built from the same content. Every value
 * is escaped in the HTML, so shopper- and CMS-controlled text is safe to pass.
 */
declare function renderTransactionalEmail(content: TransactionalEmailContent): {
    html: string;
    text: string;
};

/** Values of the `TALISMAN_EMAIL_PROVIDER` setting. */
declare const EMAIL_PROVIDERS: readonly ["cloudflare", "console", "custom", "none"];
type EmailProviderSetting = typeof EMAIL_PROVIDERS[number];
/**
 * The provider for this request, chosen by `TALISMAN_EMAIL_PROVIDER`:
 * - `cloudflare`: the `[[send_email]]` binding named by `TALISMAN_EMAIL_BINDING` (default `EMAIL`).
 * - `console`: logs messages instead of sending them; only when `TALISMAN_PUBLIC_ORIGIN` is on localhost.
 * - `custom`: the provider registered with `talismanCms({ email })`.
 * - `none`: email is off.
 * When the setting is unset, a registered custom provider wins, then a binding named `EMAIL`.
 * Returns null when nothing is configured.
 */
declare function resolveEmailProvider(env: Record<string, unknown>, configured?: EmailProviderFactory | null): EmailProvider | null;
/**
 * Parses `a@example.com`, `Name <a@example.com>`, `"Name, Inc." <a@example.com>` or `{ email, name }`.
 * Returns null for anything else, including line breaks or other control characters.
 */
declare function parseAddress(value: EmailAddressInput): ParsedAddress | null;
/**
 * Validates the message and sends it through `provider`. From and Reply-To default to the
 * `TALISMAN_EMAIL_FROM` and `TALISMAN_EMAIL_REPLY_TO` settings. Every failure is an
 * `EmailDeliveryError` whose message contains no addresses or content.
 */
declare function sendEmail(env: Record<string, unknown>, message: EmailMessage, provider: EmailProvider | null): Promise<EmailSendResult>;
/**
 * Registers a custom email provider with `talismanCms({ email: customEmail({ ... }) })`. The Worker
 * imports `exportName` from `moduleId` and calls it with `args` once; the result must be an
 * `EmailProviderFactory`. `args` are written into the build, so pass setting names, never secrets.
 */
declare function customEmail(descriptor: EmailRuntimeDescriptor): EmailRuntimeDescriptor;
/** Source of `virtual:talisman-cms/email`, which `talisman-cms/email/runtime` reads in the Worker. */
declare function buildEmailVirtualModule(email?: EmailRuntimeDescriptor | null): string;

export { EMAIL_PROVIDERS, EmailAddressInput, EmailMessage, EmailProvider, EmailProviderFactory, type EmailProviderSetting, EmailRuntimeDescriptor, EmailSendResult, ParsedAddress, SendEmailBindingLike, type TransactionalEmailContent, buildEmailVirtualModule, cloudflareEmailProvider, consoleEmailProvider, customEmail, escapeHtml, parseAddress, renderTransactionalEmail, resolveEmailProvider, sendEmail };
