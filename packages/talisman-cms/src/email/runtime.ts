import { emailProviderFactory } from 'virtual:talisman-cms/email';
import { resolveEmailProvider, sendEmail } from './index';
import type { EmailMessage, EmailProvider, EmailSendResult } from './types';

/**
 * The email provider configured for this Worker: `TALISMAN_EMAIL_PROVIDER`, the provider registered
 * with `talismanCms({ email })`, or the `[[send_email]]` binding named `EMAIL`. Null when email is off.
 */
export function getEmailProvider(env: Record<string, unknown>): EmailProvider | null {
  return resolveEmailProvider(env, emailProviderFactory);
}

/** Sends through the configured provider. Throws `EmailDeliveryError` with code 'not_configured' when there is none. */
export function sendConfiguredEmail(env: Record<string, unknown>, message: EmailMessage): Promise<EmailSendResult> {
  return sendEmail(env, message, getEmailProvider(env));
}
