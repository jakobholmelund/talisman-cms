import { renderTransactionalEmail } from 'talisman-cms/email';

/** The one-time sign-in link. `link` carries the token in its fragment, so it never reaches server logs. */
export function shopperSignInEmail({ link, siteName }: { link: string; siteName: string }) {
  return {
    kind: 'shopper-sign-in',
    subject: `Sign in to ${siteName}`.replace(/[\r\n]+/g, ' '),
    ...renderTransactionalEmail({
      siteName,
      heading: 'Your sign-in link',
      paragraphs: ['Use this one-time link to sign in. It expires in 15 minutes and works once.'],
      action: { label: 'Sign in', url: link },
      footer: "If you didn't ask to sign in, you can ignore this email.",
    }),
  };
}
