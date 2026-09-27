import { EmailProvider } from 'talisman-cms/email';
import { TalismanEnv } from 'talisman-cms/client';
import { CommerceEmailStore, CommerceEmailTemplates, CommerceEmailMessage } from './emails.js';

interface CommerceEmailSetup {
    provider: EmailProvider | null;
    /** `TALISMAN_COMMERCE_EMAIL_FROM`, else `TALISMAN_EMAIL_FROM`. */
    from: string | null;
    /** The support address when `TALISMAN_COMMERCE_SUPPORT_EMAIL` sets one; otherwise `TALISMAN_EMAIL_REPLY_TO` applies. */
    replyTo: string | null;
    store: CommerceEmailStore;
    templates: CommerceEmailTemplates | null;
}
/** An email to send, or why it is no longer sent: `cancel` when it is no longer due, `fail` when it cannot be delivered. */
type CommerceEmailComposition = {
    to: string;
    message: CommerceEmailMessage;
    onFailure?: () => Promise<unknown>;
} | {
    cancel: string;
} | {
    fail: string;
};
/**
 * Reads what an email needs at send time and builds it. `now` is also the stamp of the calling Worker's
 * claim on the email, for writes that must happen only while that Worker holds it (commerceEmailHeld).
 */
type CommerceEmailComposer = (env: TalismanEnv, subjectId: string, setup: CommerceEmailSetup, now: number) => Promise<CommerceEmailComposition>;
/** `id` is `<kind>:<subject id>`; `error` is a code or a sentence without addresses. */
type CommerceEmailResult = {
    id: string;
    status: string;
    error?: string;
};

export type { CommerceEmailComposer as C, CommerceEmailResult as a };
