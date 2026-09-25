import {
  readSetting
} from "./chunk-XG3TKNL6.js";

// src/email/types.ts
var EmailDeliveryError = class extends Error {
  constructor(code, message, provider, providerCode, options) {
    super(message, options);
    this.code = code;
    this.provider = provider;
    this.providerCode = providerCode;
  }
  name = "EmailDeliveryError";
  /** Whether sending the same message later may succeed. */
  get retryable() {
    return this.code === "rate_limited" || this.code === "quota_exceeded" || this.code === "temporary";
  }
};
function isEmailDeliveryError(error) {
  return error?.name === "EmailDeliveryError";
}

// src/email/cloudflare.ts
var CLOUDFLARE_ERROR_CODES = {
  // Account-wide suppression after bounces or complaints: the only per-recipient outcome.
  E_RECIPIENT_SUPPRESSED: "recipient_suppressed",
  // A binding allowlist, an unonboarded domain or the plan restricts recipients, so every send fails.
  E_RECIPIENT_NOT_ALLOWED: "not_configured",
  E_SENDER_NOT_VERIFIED: "sender_rejected",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "sender_rejected",
  E_RATE_LIMIT_EXCEEDED: "rate_limited",
  E_DAILY_LIMIT_EXCEEDED: "quota_exceeded",
  E_INTERNAL_SERVER_ERROR: "temporary",
  E_DELIVERY_FAILED: "delivery_failed",
  E_VALIDATION_ERROR: "invalid_message",
  E_FIELD_MISSING: "invalid_message",
  E_TOO_MANY_RECIPIENTS: "invalid_message",
  E_TOO_MANY_ATTACHMENTS: "invalid_message",
  E_CONTENT_TOO_LARGE: "invalid_message"
};
function isSendEmailBinding(value) {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof value.send === "function";
}
function mapCloudflareError(error) {
  const raw = error?.code;
  const providerCode = typeof raw === "string" && /^E_[A-Z0-9_]{1,64}$/.test(raw) ? raw : void 0;
  const code = !providerCode ? "unknown" : CLOUDFLARE_ERROR_CODES[providerCode] ?? (providerCode.startsWith("E_HEADER") ? "invalid_message" : "unknown");
  return new EmailDeliveryError(
    code,
    `Cloudflare Email Service did not accept the message${providerCode ? ` (${providerCode})` : ""}`,
    "cloudflare",
    providerCode,
    { cause: error }
  );
}
var bindingAddress = (address) => address.name ? { email: address.email, name: address.name } : address.email;
function cloudflareEmailProvider(binding) {
  return {
    id: "cloudflare",
    async send(message) {
      try {
        const { messageId } = await binding.send({
          from: bindingAddress(message.from),
          to: message.to.length === 1 ? bindingAddress(message.to[0]) : message.to.map(bindingAddress),
          subject: message.subject,
          text: message.text,
          ...message.html ? { html: message.html } : {},
          // Reply-To must use the API field; the binding rejects it as a custom header.
          ...message.replyTo ? { replyTo: bindingAddress(message.replyTo) } : {},
          headers: message.headers
        });
        return { provider: "cloudflare", messageId };
      } catch (error) {
        throw mapCloudflareError(error);
      }
    }
  };
}

// src/email/template.ts
var HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname);
}
function actionUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("Email links must be absolute URLs");
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:" && isLocalHostname(parsed.hostname)) return parsed.href;
  throw new TypeError("Email links must use https:, or http: on localhost");
}
function renderTransactionalEmail(content) {
  const url = content.action ? actionUrl(content.action.url) : void 0;
  const text = [
    content.heading,
    ...content.paragraphs,
    ...content.action && url ? [`${content.action.label}: ${url}`] : [],
    ...content.footer ? [content.footer] : [],
    content.siteName
  ].join("\n\n");
  const muted = "color:#5b635d;font-size:13px";
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#f5f5f2;color:#1f2420;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.6">`,
    '<div style="max-width:520px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">',
    `<p style="margin:0 0 24px;${muted}">${escapeHtml(content.siteName)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`),
    ...content.action && url ? [
      `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f2420;color:#ffffff;text-decoration:none">${escapeHtml(content.action.label)}</a></p>`,
      `<p style="margin:0 0 16px;${muted};word-break:break-all">${escapeHtml(url)}</p>`
    ] : [],
    ...content.footer ? [`<p style="margin:24px 0 0;${muted}">${escapeHtml(content.footer)}</p>`] : [],
    "</div></body></html>"
  ].join("\n");
  return { html, text };
}

// src/email/console.ts
var format = (address) => address.name ? `${address.name} <${address.email}>` : address.email;
function isLocalOrigin(origin) {
  if (!origin) return false;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
function consoleEmailProvider(env) {
  if (!isLocalOrigin(readSetting(env, "PUBLIC_ORIGIN"))) return null;
  return {
    id: "console",
    async send(message) {
      console.log([
        "[Talisman CMS] Email not sent (console provider)",
        `From: ${format(message.from)}`,
        `To: ${message.to.map(format).join(", ")}`,
        ...message.replyTo ? [`Reply-To: ${format(message.replyTo)}`] : [],
        `Subject: ${message.subject}`,
        "",
        message.text
      ].join("\n"));
      return { provider: "console" };
    }
  };
}

// src/email/index.ts
var EMAIL_PROVIDERS = ["cloudflare", "console", "custom", "none"];
var NOT_EMAIL_BINDINGS = /* @__PURE__ */ new Set(["DB", "KV", "SESSION", "QUEUE", "STORAGE", "IMAGES", "AI", "ASSETS"]);
var WARNINGS_KEY = "__TALISMAN_CMS_EMAIL_WARNINGS__";
function warnOnce(message) {
  const runtime = globalThis;
  const warned = runtime[WARNINGS_KEY] ??= /* @__PURE__ */ new Set();
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[Talisman CMS] ${message}`);
}
function resolveEmailProvider(env, configured = null) {
  const raw = readSetting(env, "EMAIL_PROVIDER");
  const choice = raw?.toLowerCase();
  if (choice && !EMAIL_PROVIDERS.includes(choice)) {
    warnOnce(`TALISMAN_EMAIL_PROVIDER "${raw.slice(0, 32)}" is not one of ${EMAIL_PROVIDERS.join(", ")}; email is off.`);
    return null;
  }
  if (choice === "none") return null;
  if (choice === "custom" || !choice && configured) {
    if (typeof configured !== "function") {
      warnOnce(choice === "custom" ? "TALISMAN_EMAIL_PROVIDER is custom, but talismanCms({ email }) registers no provider; email is off." : "The talismanCms({ email }) provider must return a function that builds the provider from the Worker env; email is off.");
      return null;
    }
    return configured(env);
  }
  if (choice === "console") {
    const provider = consoleEmailProvider(env);
    if (!provider) warnOnce("The console email provider runs only when TALISMAN_PUBLIC_ORIGIN is a localhost origin; email is off.");
    return provider;
  }
  const bindingName = readSetting(env, "EMAIL_BINDING") ?? "EMAIL";
  if (NOT_EMAIL_BINDINGS.has(bindingName)) {
    warnOnce(`TALISMAN_EMAIL_BINDING must name a [[send_email]] binding, not ${bindingName}; email is off.`);
    return null;
  }
  const binding = env[bindingName];
  if (isSendEmailBinding(binding)) return cloudflareEmailProvider(binding);
  if (choice === "cloudflare") {
    warnOnce(`TALISMAN_EMAIL_PROVIDER is cloudflare, but the Worker has no [[send_email]] binding named ${bindingName}; email is off.`);
  }
  return null;
}
var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
var EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(?:\.[^\s@<>()[\]\\,;:".]+)+$/;
var NAMED_ADDRESS = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<>"]*?))\s*<([^<>]*)>\s*$/;
function checkedAddress(email, name) {
  if (typeof email !== "string") return null;
  const address = email.trim();
  if (address.length > 254 || !EMAIL_ADDRESS.test(address)) return null;
  if (name === void 0 || name === null || name === "") return { email: address };
  if (typeof name !== "string" || name.length > 256 || CONTROL_CHARACTERS.test(name)) return null;
  const display = name.trim();
  return display ? { email: address, name: display } : { email: address };
}
function parseAddress(value) {
  if (typeof value === "object" && value !== null) return checkedAddress(value.email, value.name);
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return null;
  const named = value.match(NAMED_ADDRESS);
  if (!named) return checkedAddress(value);
  const name = named[1] !== void 0 ? named[1].replace(/\\(.)/g, "$1") : named[2];
  return checkedAddress(named[3], name);
}
var MAX_RECIPIENTS = 50;
var HEADER_NAME = /^X-[A-Za-z0-9_-]{1,98}$/;
var EMAIL_KIND = /^[a-z0-9-]{1,64}$/;
var HEADER_VALUE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
function invalid(provider, message) {
  return new EmailDeliveryError("invalid_message", message, provider);
}
function resolveMessage(env, message, provider) {
  const fromInput = message.from ?? readSetting(env, "EMAIL_FROM");
  if (!fromInput) throw new EmailDeliveryError("not_configured", "No sender address is configured; set TALISMAN_EMAIL_FROM", provider);
  const from = parseAddress(fromInput);
  if (!from) throw invalid(provider, "The sender address is invalid");
  const replyToInput = message.replyTo ?? readSetting(env, "EMAIL_REPLY_TO");
  const replyTo = replyToInput ? parseAddress(replyToInput) : void 0;
  if (replyTo === null) throw invalid(provider, "The Reply-To address is invalid");
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw invalid(provider, `A message needs 1 to ${MAX_RECIPIENTS} recipients`);
  const to = recipients.map(parseAddress);
  if (to.some((address) => !address)) throw invalid(provider, "A recipient address is invalid");
  if (typeof message.subject !== "string" || !message.subject.trim() || message.subject.length > 998 || CONTROL_CHARACTERS.test(message.subject)) {
    throw invalid(provider, "The subject must be one line of 1 to 998 characters");
  }
  if (typeof message.text !== "string" || !message.text.trim()) throw invalid(provider, "A plain-text part is required");
  if (message.html !== void 0 && typeof message.html !== "string") throw invalid(provider, "The HTML part must be a string");
  if (message.kind !== void 0 && (typeof message.kind !== "string" || !EMAIL_KIND.test(message.kind))) {
    throw invalid(provider, "The email kind must use lowercase letters, digits and hyphens");
  }
  const headers = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw invalid(provider, "Custom headers must be X- headers");
    if (typeof value !== "string" || HEADER_VALUE_CONTROL.test(value) || new TextEncoder().encode(value).byteLength > 2048) {
      throw invalid(provider, "Header values must be one line of at most 2,048 bytes");
    }
    headers[name] = value;
  }
  if (message.kind) headers["X-Talisman-Email"] = message.kind;
  headers["Auto-Submitted"] = "auto-generated";
  return {
    to,
    from,
    ...replyTo ? { replyTo } : {},
    subject: message.subject,
    text: message.text,
    ...message.html ? { html: message.html } : {},
    headers,
    ...message.kind ? { kind: message.kind } : {}
  };
}
async function sendEmail(env, message, provider) {
  if (!provider) throw new EmailDeliveryError("not_configured", "No email provider is configured", "none");
  const resolved = resolveMessage(env, message, provider.id);
  try {
    return await provider.send(resolved);
  } catch (error) {
    if (isEmailDeliveryError(error)) throw error;
    throw new EmailDeliveryError("unknown", `Email provider ${provider.id} failed`, provider.id, void 0, { cause: error });
  }
}
var IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
var SECRET_LIKE = /^(?:re_|sk_|rk_|whsec_|xkeysib-|SG\.)/;
function checkDescriptorArgument(value, path) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
  } else if (typeof value === "string") {
    if (!SECRET_LIKE.test(value)) return;
    throw new TypeError(`[talisman-cms] email ${path} looks like a secret. Arguments are written into the build; pass the name of a Worker secret instead.`);
  } else if (Array.isArray(value)) {
    return value.forEach((item, index) => checkDescriptorArgument(item, `${path}[${index}]`));
  } else if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).forEach(([key, item]) => checkDescriptorArgument(item, `${path}.${key}`));
  }
  throw new TypeError(`[talisman-cms] email ${path} must be JSON: null, a boolean, a finite number, a string, an array or a plain object.`);
}
function customEmail(descriptor) {
  const { moduleId, exportName, args = [] } = descriptor ?? {};
  if (typeof moduleId !== "string" || !moduleId.trim()) {
    throw new TypeError("[talisman-cms] email.moduleId must be a package specifier or an absolute path.");
  }
  if (typeof exportName !== "string" || !IDENTIFIER.test(exportName)) {
    throw new TypeError("[talisman-cms] email.exportName must name a named export of email.moduleId.");
  }
  if (!Array.isArray(args)) throw new TypeError("[talisman-cms] email.args must be an array.");
  checkDescriptorArgument(args, "args");
  return { moduleId, exportName, args };
}
function buildEmailVirtualModule(email) {
  if (!email) return "export const emailProviderFactory = null;\n";
  const { moduleId, exportName, args } = customEmail(email);
  return [
    `import { ${exportName} as __talismanCmsEmailProvider } from ${JSON.stringify(moduleId)};`,
    `export const emailProviderFactory = __talismanCmsEmailProvider(...${JSON.stringify(args)});`,
    ""
  ].join("\n");
}

export {
  EmailDeliveryError,
  isEmailDeliveryError,
  cloudflareEmailProvider,
  escapeHtml,
  renderTransactionalEmail,
  consoleEmailProvider,
  EMAIL_PROVIDERS,
  resolveEmailProvider,
  parseAddress,
  sendEmail,
  customEmail,
  buildEmailVirtualModule
};
