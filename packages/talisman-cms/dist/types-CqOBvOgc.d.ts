/** `'a@example.com'`, `'Name <a@example.com>'`, `'"Name, Inc." <a@example.com>'` or `{ email, name }`. */
type EmailAddressInput = string | {
    email: string;
    name?: string;
};
interface ParsedAddress {
    email: string;
    name?: string;
}
interface EmailMessage {
    /** At most 50 recipients. Talisman sends one recipient per message. */
    to: EmailAddressInput | EmailAddressInput[];
    /** One line of at most 998 characters. */
    subject: string;
    /** The plain-text part is always required. */
    text: string;
    html?: string;
    /** Defaults to the `TALISMAN_EMAIL_FROM` setting. */
    from?: EmailAddressInput;
    /** Defaults to the `TALISMAN_EMAIL_REPLY_TO` setting. */
    replyTo?: EmailAddressInput;
    /** Extra `X-*` headers only. Values must be one line of at most 2,048 bytes. */
    headers?: Record<string, string>;
    /** Lowercase letters, digits and hyphens, sent as `X-Talisman-Email` so each kind can be filtered in delivery logs. */
    kind?: string;
}
/** A validated message as providers receive it. `headers` always includes `Auto-Submitted: auto-generated`. */
interface ResolvedEmailMessage {
    to: ParsedAddress[];
    from: ParsedAddress;
    replyTo?: ParsedAddress;
    subject: string;
    text: string;
    html?: string;
    headers: Record<string, string>;
    kind?: string;
}
/** The provider accepted the message. Delivery happens later and is not confirmed here. */
interface EmailSendResult {
    provider: string;
    messageId?: string;
}
type EmailErrorCode = 'not_configured' | 'invalid_message' | 'sender_rejected' | 'recipient_suppressed' | 'rate_limited' | 'quota_exceeded' | 'temporary' | 'delivery_failed' | 'unknown';
/**
 * A send that failed. `message` never contains addresses or message content, so the error is safe
 * to log; the provider's original error is kept as `cause`.
 */
declare class EmailDeliveryError extends Error {
    readonly code: EmailErrorCode;
    readonly provider: string;
    readonly providerCode?: string | undefined;
    readonly name = "EmailDeliveryError";
    constructor(code: EmailErrorCode, message: string, provider: string, providerCode?: string | undefined, options?: {
        cause?: unknown;
    });
    /** Whether sending the same message later may succeed. */
    get retryable(): boolean;
}
/** Checks the name rather than `instanceof`, because a site can bundle more than one copy of this module. */
declare function isEmailDeliveryError(error: unknown): error is EmailDeliveryError;
interface EmailProvider {
    readonly id: string;
    send(message: ResolvedEmailMessage): Promise<EmailSendResult>;
}
/** Builds a provider from the Worker env for each request, or returns null when it is not configured. Read secrets here. */
type EmailProviderFactory = (env: Record<string, unknown>) => EmailProvider | null;
/**
 * A custom email provider that the Worker loads at runtime. `talismanCms({ email })` imports
 * `exportName` from `moduleId` and calls it with `args` once; it must return an `EmailProviderFactory`.
 * `args` are written into the build, so pass setting names, never secrets.
 */
interface EmailRuntimeDescriptor {
    /** A package specifier or an absolute path that the site's build can resolve. */
    moduleId: string;
    exportName: string;
    args?: unknown[];
}
/** The part of the Workers `SendEmail` binding that Talisman uses. */
interface SendEmailBindingLike {
    send(builder: {
        from: string | {
            email: string;
            name: string;
        };
        to: string | Array<string | {
            email: string;
            name: string;
        }> | {
            email: string;
            name: string;
        };
        subject: string;
        text?: string;
        html?: string;
        replyTo?: string | {
            email: string;
            name: string;
        };
        headers?: Record<string, string>;
    }): Promise<{
        messageId: string;
    }>;
}

export { type EmailRuntimeDescriptor as E, type ParsedAddress as P, type ResolvedEmailMessage as R, type SendEmailBindingLike as S, type EmailProvider as a, type EmailMessage as b, type EmailSendResult as c, type EmailAddressInput as d, type EmailProviderFactory as e, EmailDeliveryError as f, type EmailErrorCode as g, isEmailDeliveryError as i };
