import { EmailDeliveryError } from './types';
import type { EmailErrorCode, EmailProvider, ParsedAddress, SendEmailBindingLike } from './types';

// Error codes thrown by the `send_email` binding. Anything else maps to 'unknown'.
const CLOUDFLARE_ERROR_CODES: Record<string, EmailErrorCode> = {
  // Account-wide suppression after bounces or complaints: the only per-recipient outcome.
  E_RECIPIENT_SUPPRESSED: 'recipient_suppressed',
  // A binding allowlist, an unonboarded domain or the plan restricts recipients, so every send fails.
  E_RECIPIENT_NOT_ALLOWED: 'not_configured',
  E_SENDER_NOT_VERIFIED: 'sender_rejected',
  E_SENDER_DOMAIN_NOT_AVAILABLE: 'sender_rejected',
  E_RATE_LIMIT_EXCEEDED: 'rate_limited',
  E_DAILY_LIMIT_EXCEEDED: 'quota_exceeded',
  E_INTERNAL_SERVER_ERROR: 'temporary',
  E_DELIVERY_FAILED: 'delivery_failed',
  E_VALIDATION_ERROR: 'invalid_message',
  E_FIELD_MISSING: 'invalid_message',
  E_TOO_MANY_RECIPIENTS: 'invalid_message',
  E_TOO_MANY_ATTACHMENTS: 'invalid_message',
  E_CONTENT_TOO_LARGE: 'invalid_message',
};

/** Any binding with a `send()` method. Queue producers have one too, so the binding name is checked separately. */
export function isSendEmailBinding(value: unknown): value is SendEmailBindingLike {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { send?: unknown }).send === 'function';
}

function mapCloudflareError(error: unknown) {
  const raw = (error as { code?: unknown } | null)?.code;
  const providerCode = typeof raw === 'string' && /^E_[A-Z0-9_]{1,64}$/.test(raw) ? raw : undefined;
  const code: EmailErrorCode = !providerCode ? 'unknown'
    : CLOUDFLARE_ERROR_CODES[providerCode] ?? (providerCode.startsWith('E_HEADER') ? 'invalid_message' : 'unknown');
  // The binding's own message can include addresses, so it is kept only as the cause.
  return new EmailDeliveryError(code, `Cloudflare Email Service did not accept the message${providerCode ? ` (${providerCode})` : ''}`,
    'cloudflare', providerCode, { cause: error });
}

// The installed Workers types require `name` on address objects, so a bare address is sent as a string.
const bindingAddress = (address: ParsedAddress) => address.name ? { email: address.email, name: address.name } : address.email;

/** Sends through a Cloudflare Email Service `[[send_email]]` binding. */
export function cloudflareEmailProvider(binding: SendEmailBindingLike): EmailProvider {
  return {
    id: 'cloudflare',
    async send(message) {
      try {
        const { messageId } = await binding.send({
          from: bindingAddress(message.from),
          to: message.to.length === 1 ? bindingAddress(message.to[0]) : message.to.map(bindingAddress),
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          // Reply-To must use the API field; the binding rejects it as a custom header.
          ...(message.replyTo ? { replyTo: bindingAddress(message.replyTo) } : {}),
          headers: message.headers,
        });
        return { provider: 'cloudflare', messageId };
      } catch (error) {
        throw mapCloudflareError(error);
      }
    },
  };
}
