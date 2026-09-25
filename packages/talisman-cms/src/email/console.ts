import { readSetting } from '../env';
import { isLocalHostname } from './template';
import type { EmailProvider, ParsedAddress } from './types';

const format = (address: ParsedAddress) => address.name ? `${address.name} <${address.email}>` : address.email;

function isLocalOrigin(origin: string | undefined) {
  if (!origin) return false;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Development only: writes each message, links included, to the Worker log instead of sending it.
 * Returns null unless `TALISMAN_PUBLIC_ORIGIN` is a localhost origin, so it cannot run in production.
 */
export function consoleEmailProvider(env: Record<string, unknown>): EmailProvider | null {
  if (!isLocalOrigin(readSetting(env, 'PUBLIC_ORIGIN'))) return null;
  return {
    id: 'console',
    async send(message) {
      console.log([
        '[Talisman CMS] Email not sent (console provider)',
        `From: ${format(message.from)}`,
        `To: ${message.to.map(format).join(', ')}`,
        ...(message.replyTo ? [`Reply-To: ${format(message.replyTo)}`] : []),
        `Subject: ${message.subject}`,
        '',
        message.text,
      ].join('\n'));
      return { provider: 'console' };
    },
  };
}
