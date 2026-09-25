import { a as EmailProvider, b as EmailMessage, c as EmailSendResult } from '../types-CqOBvOgc.js';

/**
 * The email provider configured for this Worker: `TALISMAN_EMAIL_PROVIDER`, the provider registered
 * with `talismanCms({ email })`, or the `[[send_email]]` binding named `EMAIL`. Null when email is off.
 */
declare function getEmailProvider(env: Record<string, unknown>): EmailProvider | null;
/** Sends through the configured provider. Throws `EmailDeliveryError` with code 'not_configured' when there is none. */
declare function sendConfiguredEmail(env: Record<string, unknown>, message: EmailMessage): Promise<EmailSendResult>;

export { getEmailProvider, sendConfiguredEmail };
