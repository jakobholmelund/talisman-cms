import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  EmailDeliveryError, buildEmailVirtualModule, cloudflareEmailProvider, consoleEmailProvider, customEmail, escapeHtml,
  isEmailDeliveryError, parseAddress, renderTransactionalEmail, resolveEmailProvider, sendEmail,
} from '../dist/email/index.js';

// `talisman-cms/email/runtime` reads the provider registered with talismanCms({ email }) from a virtual module.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'virtual:talisman-cms/email') return nextResolve(specifier, context);
    return {
      url: 'data:text/javascript,export const emailProviderFactory = globalThis.__talismanEmailFactory ?? null;',
      shortCircuit: true,
    };
  },
});

const FROM = 'Talisman Vision <no-reply@talisman.vision>';

function fakeBinding(result = { messageId: '<m1@talisman.vision>' }) {
  const calls = [];
  return {
    calls,
    async send(builder) {
      calls.push(builder);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function bindingError(code) {
  return Object.assign(new Error(`${code}: shopper@example.com was not accepted`), { code });
}

function recordingProvider() {
  const sent = [];
  return { sent, provider: { id: 'recording', async send(message) { sent.push(message); return { provider: 'recording' }; } } };
}

test('the provider comes from TALISMAN_EMAIL_PROVIDER, a registered provider or the EMAIL binding', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const EMAIL = fakeBinding();
  const custom = { id: 'custom', async send() { return { provider: 'custom' }; } };
  const configured = () => custom;

  assert.equal(resolveEmailProvider({ EMAIL })?.id, 'cloudflare');
  assert.equal(resolveEmailProvider({}), null);
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'CloudFlare', EMAIL })?.id, 'cloudflare');
  assert.equal(resolveEmailProvider({ EMAIL }, configured), custom, 'a registered provider wins while the setting is unset');
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'custom', EMAIL }, configured), custom);
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'cloudflare', EMAIL }, configured)?.id, 'cloudflare');
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'none', EMAIL }, configured), null);
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_BINDING: 'MAILER', MAILER: EMAIL })?.id, 'cloudflare');
  assert.equal(error.mock.callCount(), 0, 'valid configurations log nothing');
});

test('email configuration mistakes turn email off and log once per isolate', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const EMAIL = fakeBinding();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'cloudfare', EMAIL }), null);
  }
  assert.equal(error.mock.callCount(), 1);
  assert.match(String(error.mock.calls[0].arguments[0]), /cloudfare/);

  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'custom', EMAIL }), null);
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'cloudflare' }), null);
  // Queue producers also have send(); the binding name must point at a [[send_email]] binding.
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_BINDING: 'QUEUE', QUEUE: EMAIL }), null);
  assert.equal(resolveEmailProvider({ TALISMAN_EMAIL_PROVIDER: 'cloudflare', TALISMAN_EMAIL_BINDING: 'MAILER', MAILER: { send: 'no' } }), null);
  assert.equal(resolveEmailProvider({ EMAIL }, { not: 'a factory' }), null);
  assert.equal(error.mock.callCount(), 6);
  const logged = error.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.match(logged, /talismanCms\(\{ email \}\)/);
  assert.match(logged, /no \[\[send_email\]\] binding named EMAIL/);
  assert.match(logged, /not QUEUE/);
});

test('the console provider runs only for a localhost public origin', async (t) => {
  t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const local = { TALISMAN_EMAIL_PROVIDER: 'console', TALISMAN_PUBLIC_ORIGIN: 'http://localhost:4321', TALISMAN_EMAIL_FROM: FROM };
  const provider = resolveEmailProvider(local, () => ({ id: 'custom', async send() {} }));
  assert.equal(provider?.id, 'console');
  assert.deepEqual(await sendEmail(local, { to: 'shopper@example.com', subject: 'Hello', text: 'Link: http://localhost:4321/x' }, provider),
    { provider: 'console' });
  assert.match(String(log.mock.calls[0].arguments[0]), /To: shopper@example\.com[\s\S]*Link: http:\/\/localhost:4321\/x/);
  assert.equal(resolveEmailProvider({ ...local, TALISMAN_PUBLIC_ORIGIN: 'https://talisman.vision' }), null);
  assert.equal(resolveEmailProvider({ ...local, TALISMAN_PUBLIC_ORIGIN: undefined }), null);
  // Used directly, as a registered provider, it is guarded the same way.
  assert.equal(consoleEmailProvider({ TALISMAN_PUBLIC_ORIGIN: 'https://localhost.example.com' }), null);
  assert.equal(consoleEmailProvider({ TALISMAN_PUBLIC_ORIGIN: 'http://127.0.0.1:8787' })?.id, 'console');
});

test('pre-rename GALAXY_EMAIL_* settings still apply', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const EMAIL = fakeBinding();
  const env = { GALAXY_EMAIL_PROVIDER: 'cloudflare', GALAXY_EMAIL_FROM: FROM, GALAXY_EMAIL_REPLY_TO: 'hello@talisman.vision', EMAIL };
  await sendEmail(env, { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' }, resolveEmailProvider(env));
  assert.equal(EMAIL.calls[0].replyTo, 'hello@talisman.vision');
  assert.deepEqual(EMAIL.calls[0].from, { email: 'no-reply@talisman.vision', name: 'Talisman Vision' });
});

test('parseAddress accepts plain, named and quoted addresses and rejects header injection', () => {
  assert.deepEqual(parseAddress(FROM), { email: 'no-reply@talisman.vision', name: 'Talisman Vision' });
  assert.deepEqual(parseAddress('"Talisman, Inc." <a@b.example>'), { email: 'a@b.example', name: 'Talisman, Inc.' });
  assert.deepEqual(parseAddress('"Say \\"hi\\"" <a@b.example>'), { email: 'a@b.example', name: 'Say "hi"' });
  assert.deepEqual(parseAddress(' shopper+tag@example.com '), { email: 'shopper+tag@example.com' });
  assert.deepEqual(parseAddress('<shopper@example.com>'), { email: 'shopper@example.com' });
  assert.deepEqual(parseAddress({ email: 'shopper@example.com', name: 'Shopper' }), { email: 'shopper@example.com', name: 'Shopper' });
  for (const bad of ['shopper@example.com\r\nBcc: victim@example.com', 'Name <a@b.example>\nBcc: c@d.example',
    'no-at-sign.example', 'a@b', 'a<b@c.example', 'Name <a@b.example', 'a b@c.example', `${'a'.repeat(250)}@b.example`,
    '', { email: 'a@b.example', name: 'Line\nbreak' }, { email: 42 }]) {
    assert.equal(parseAddress(bad), null, JSON.stringify(bad));
  }
});

test('sendEmail validates messages and adds the default sender, Reply-To and Auto-Submitted', async () => {
  const { sent, provider } = recordingProvider();
  const env = { TALISMAN_EMAIL_FROM: FROM, TALISMAN_EMAIL_REPLY_TO: 'hello@talisman.vision' };
  const message = { to: 'shopper@example.com', subject: 'Sign in', text: 'Link', html: '<p>Link</p>', kind: 'shopper-sign-in',
    headers: { 'X-Order-Id': 'ord_1' } };
  assert.deepEqual(await sendEmail(env, message, provider), { provider: 'recording' });
  assert.deepEqual(sent[0], {
    to: [{ email: 'shopper@example.com' }],
    from: { email: 'no-reply@talisman.vision', name: 'Talisman Vision' },
    replyTo: { email: 'hello@talisman.vision' },
    subject: 'Sign in', text: 'Link', html: '<p>Link</p>', kind: 'shopper-sign-in',
    headers: { 'X-Order-Id': 'ord_1', 'X-Talisman-Email': 'shopper-sign-in', 'Auto-Submitted': 'auto-generated' },
  });
  await sendEmail(env, { ...message, from: 'orders@talisman.vision', replyTo: 'support@talisman.vision' }, provider);
  assert.deepEqual([sent[1].from, sent[1].replyTo], [{ email: 'orders@talisman.vision' }, { email: 'support@talisman.vision' }]);

  const rejects = async (env, change, code) => {
    await assert.rejects(sendEmail(env, { ...message, ...change }, provider), (error) => {
      assert.ok(isEmailDeliveryError(error));
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /shopper@example\.com|victim/);
      return true;
    }, JSON.stringify(change));
  };
  await assert.rejects(sendEmail(env, message, null), (error) => error.code === 'not_configured');
  await rejects({}, {}, 'not_configured');
  await rejects(env, { subject: 'Hi\r\nBcc: victim@example.com' }, 'invalid_message');
  await rejects(env, { subject: '   ' }, 'invalid_message');
  await rejects(env, { subject: 'x'.repeat(999) }, 'invalid_message');
  await rejects(env, { text: '' }, 'invalid_message');
  await rejects(env, { headers: { Bcc: 'victim@example.com' } }, 'invalid_message');
  await rejects(env, { headers: { 'Reply-To': 'victim@example.com' } }, 'invalid_message');
  await rejects(env, { headers: { 'X-Foo\r\nBcc': 'victim@example.com' } }, 'invalid_message');
  await rejects(env, { headers: { 'X-Foo': 'a\r\nBcc: victim@example.com' } }, 'invalid_message');
  await rejects(env, { headers: { 'X-Foo': 'é'.repeat(1025) } }, 'invalid_message');
  await rejects(env, { to: Array.from({ length: 51 }, (_, index) => `s${index}@example.com`) }, 'invalid_message');
  await rejects(env, { to: [] }, 'invalid_message');
  await rejects(env, { to: 'victim@example.com\r\nBcc: other@example.com' }, 'invalid_message');
  await rejects(env, { kind: 'Shopper Sign-In' }, 'invalid_message');
  await rejects(env, { from: 'not an address' }, 'invalid_message');
  await rejects({ ...env, TALISMAN_EMAIL_REPLY_TO: 'bad\naddress' }, {}, 'invalid_message');
  assert.equal(sent.length, 2, 'invalid messages never reach the provider');
});

test('failures from custom providers become EmailDeliveryError', async () => {
  const cause = new Error('boom for shopper@example.com');
  const provider = { id: 'postmark', async send() { throw cause; } };
  await assert.rejects(sendEmail({ TALISMAN_EMAIL_FROM: FROM }, { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' }, provider),
    (error) => error instanceof EmailDeliveryError && error.code === 'unknown' && error.provider === 'postmark'
      && error.cause === cause && !error.message.includes('shopper@'));
  const passthrough = new EmailDeliveryError('rate_limited', 'Slow down', 'postmark', '429');
  await assert.rejects(sendEmail({ TALISMAN_EMAIL_FROM: FROM }, { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' },
    { id: 'postmark', async send() { throw passthrough; } }), (error) => error === passthrough && error.retryable);
});

test('the Cloudflare provider sends a MessageBuilder through the send_email binding', async () => {
  const binding = fakeBinding();
  const provider = cloudflareEmailProvider(binding);
  const env = { TALISMAN_EMAIL_FROM: 'no-reply@talisman.vision', TALISMAN_EMAIL_REPLY_TO: 'Talisman Vision <hello@talisman.vision>' };
  assert.deepEqual(await sendEmail(env, { to: 'shopper@example.com', subject: 'Sign in', text: 'Link', html: '<p>Link</p>', kind: 'shopper-sign-in' }, provider),
    { provider: 'cloudflare', messageId: '<m1@talisman.vision>' });
  assert.deepEqual(binding.calls[0], {
    from: 'no-reply@talisman.vision',
    to: 'shopper@example.com',
    subject: 'Sign in', text: 'Link', html: '<p>Link</p>',
    replyTo: { email: 'hello@talisman.vision', name: 'Talisman Vision' },
    headers: { 'X-Talisman-Email': 'shopper-sign-in', 'Auto-Submitted': 'auto-generated' },
  });
  await sendEmail({ TALISMAN_EMAIL_FROM: FROM }, { to: ['a@example.com', { email: 'b@example.com', name: 'B' }], subject: 'Hi', text: 'Hi' }, provider);
  assert.deepEqual(binding.calls[1].from, { email: 'no-reply@talisman.vision', name: 'Talisman Vision' });
  assert.deepEqual(binding.calls[1].to, ['a@example.com', { email: 'b@example.com', name: 'B' }]);
  assert.equal('replyTo' in binding.calls[1], false);
});

test('Cloudflare error codes map to email error codes without exposing addresses', async () => {
  const expected = {
    E_RECIPIENT_SUPPRESSED: ['recipient_suppressed', false],
    E_RECIPIENT_NOT_ALLOWED: ['not_configured', false],
    E_SENDER_NOT_VERIFIED: ['sender_rejected', false],
    E_SENDER_DOMAIN_NOT_AVAILABLE: ['sender_rejected', false],
    E_RATE_LIMIT_EXCEEDED: ['rate_limited', true],
    E_DAILY_LIMIT_EXCEEDED: ['quota_exceeded', true],
    E_INTERNAL_SERVER_ERROR: ['temporary', true],
    E_DELIVERY_FAILED: ['delivery_failed', false],
    E_VALIDATION_ERROR: ['invalid_message', false],
    E_HEADER_NOT_ALLOWED: ['invalid_message', false],
    E_SOMETHING_NEW: ['unknown', false],
  };
  const env = { TALISMAN_EMAIL_FROM: FROM };
  for (const [providerCode, [code, retryable]] of Object.entries(expected)) {
    const cause = bindingError(providerCode);
    await assert.rejects(sendEmail(env, { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' }, cloudflareEmailProvider(fakeBinding(cause))),
      (error) => {
        assert.ok(isEmailDeliveryError(error));
        assert.deepEqual([error.code, error.retryable, error.provider, error.providerCode], [code, retryable, 'cloudflare', providerCode]);
        assert.equal(error.cause, cause);
        assert.doesNotMatch(error.message, /shopper@example\.com/);
        return true;
      }, providerCode);
  }
  // The local simulator throws plain errors, for example when the sender is not in allowed_sender_addresses.
  await assert.rejects(sendEmail(env, { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' },
    cloudflareEmailProvider(fakeBinding(new Error('email from no-reply@talisman.vision not allowed')))),
  (error) => error.code === 'unknown' && error.providerCode === undefined && !error.message.includes('@'));
});

test('custom provider descriptors are validated and serialised into the virtual module', () => {
  assert.equal(buildEmailVirtualModule(), 'export const emailProviderFactory = null;\n');
  assert.equal(buildEmailVirtualModule(null), 'export const emailProviderFactory = null;\n');
  const source = buildEmailVirtualModule(customEmail({ moduleId: '/site/src/email/postmark.ts', exportName: 'postmarkEmail',
    args: [{ tokenVar: 'POSTMARK_TOKEN', retries: 2, sandbox: false, tags: ['shop'] }] }));
  assert.equal(source, [
    'import { postmarkEmail as __talismanCmsEmailProvider } from "/site/src/email/postmark.ts";',
    'export const emailProviderFactory = __talismanCmsEmailProvider(...[{"tokenVar":"POSTMARK_TOKEN","retries":2,"sandbox":false,"tags":["shop"]}]);',
    '',
  ].join('\n'));
  assert.deepEqual(customEmail({ moduleId: 'email-pkg', exportName: 'factory' }), { moduleId: 'email-pkg', exportName: 'factory', args: [] });

  assert.throws(() => customEmail({ moduleId: '', exportName: 'factory' }), /moduleId/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'default; import "evil"' }), /exportName/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'factory', args: 'POSTMARK_TOKEN' }), /array/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'factory', args: [{ key: 're_123456' }] }), /args\[0\]\.key looks like a secret/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'factory', args: ['sk_live_abc'] }), /secret/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'factory', args: [() => {}] }), /must be JSON/);
  assert.throws(() => customEmail({ moduleId: 'x', exportName: 'factory', args: [new Date()] }), /must be JSON/);
  assert.throws(() => buildEmailVirtualModule({ moduleId: 'x', exportName: '1bad' }), /exportName/);
});

test('talismanCms({ email }) validates the descriptor and serves it as virtual:talisman-cms/email', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { default: talismanCms } = await import('../dist/integration.js');
  assert.throws(() => talismanCms({ email: { moduleId: 'email-pkg', exportName: 'not valid' } }), /exportName/);
  assert.throws(() => talismanCms({ plugins: [{ name: 'mail', onInit: (config) => ({ ...config, email: { moduleId: 'email-pkg', exportName: 'factory', args: ['whsec_1'] } }) }] }),
    /secret/, 'a descriptor set by a plugin is validated too');
  const served = (options) => {
    let config;
    talismanCms(options).hooks['astro:config:setup']({ injectRoute() {}, updateConfig(value) { config = value; }, addDevToolbarApp() {} });
    const plugin = config.vite.plugins.find((candidate) => candidate?.name === 'vite-plugin-talisman-cms-email');
    return plugin.load(plugin.resolveId('virtual:talisman-cms/email'));
  };
  assert.equal(served({}), 'export const emailProviderFactory = null;\n');
  assert.match(served({ email: customEmail({ moduleId: 'email-pkg', exportName: 'factory', args: ['POSTMARK_TOKEN'] }) }),
    /import \{ factory as __talismanCmsEmailProvider \} from "email-pkg";\nexport const emailProviderFactory = __talismanCmsEmailProvider\(\.\.\.\["POSTMARK_TOKEN"\]\);/);
});

test('the runtime entry uses the provider registered with talismanCms({ email })', async () => {
  const provider = { id: 'registered', async send(message) { return { provider: 'registered', messageId: message.to[0].email }; } };
  globalThis.__talismanEmailFactory = (env) => (env.REGISTERED === 'yes' ? provider : null);
  const { getEmailProvider, sendConfiguredEmail } = await import('../dist/email/runtime.js');
  assert.equal(getEmailProvider({ REGISTERED: 'yes' }), provider);
  assert.equal(getEmailProvider({ REGISTERED: 'no', EMAIL: fakeBinding() }), null);
  assert.equal(getEmailProvider({ REGISTERED: 'yes', TALISMAN_EMAIL_PROVIDER: 'none' }), null);
  assert.deepEqual(await sendConfiguredEmail({ REGISTERED: 'yes', TALISMAN_EMAIL_FROM: FROM },
    { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' }), { provider: 'registered', messageId: 'shopper@example.com' });
  await assert.rejects(sendConfiguredEmail({ TALISMAN_EMAIL_PROVIDER: 'none', TALISMAN_EMAIL_FROM: FROM },
    { to: 'shopper@example.com', subject: 'Hi', text: 'Hi' }), (error) => error.code === 'not_configured');
});

test('transactional templates escape content and only link to https or localhost', () => {
  const { html, text } = renderTransactionalEmail({
    siteName: 'Talisman <Vision>',
    heading: 'Hello "there"',
    paragraphs: ['<script>alert(1)</script>', "Tom & Jerry's"],
    action: { label: 'Sign in', url: 'https://talisman.vision/account/verify#token=abc' },
    footer: 'Ignore <b>this</b>.',
  });
  assert.doesNotMatch(html, /<script>|<Vision>|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Tom &amp; Jerry&#39;s/);
  assert.match(html, /href="https:\/\/talisman\.vision\/account\/verify#token=abc"/);
  assert.equal(text, [
    'Hello "there"', '<script>alert(1)</script>', "Tom & Jerry's",
    'Sign in: https://talisman.vision/account/verify#token=abc', 'Ignore <b>this</b>.', 'Talisman <Vision>',
  ].join('\n\n'));
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const content = { siteName: 'S', heading: 'H', paragraphs: [] };
  assert.match(renderTransactionalEmail({ ...content, action: { label: 'Go', url: 'http://localhost:4321/a' } }).text, /Go: http:\/\/localhost:4321\/a/);
  for (const url of ['javascript:alert(1)', 'http://talisman.vision/a', 'data:text/html,hi', '/relative']) {
    assert.throws(() => renderTransactionalEmail({ ...content, action: { label: 'Go', url } }), TypeError, url);
  }
});
