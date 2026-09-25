const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHostname(hostname: string) {
  return LOCAL_HOSTNAMES.has(hostname);
}

/** Links in mail must be https:, except http: on localhost for development. */
function actionUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('Email links must be absolute URLs');
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))) return parsed.href;
  throw new TypeError('Email links must use https:, or http: on localhost');
}

export interface TransactionalEmailContent {
  siteName: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footer?: string;
}

/**
 * A plain-text part and a minimal inline-styled HTML part built from the same content. Every value
 * is escaped in the HTML, so shopper- and CMS-controlled text is safe to pass.
 */
export function renderTransactionalEmail(content: TransactionalEmailContent): { html: string; text: string } {
  const url = content.action ? actionUrl(content.action.url) : undefined;
  const text = [
    content.heading,
    ...content.paragraphs,
    ...(content.action && url ? [`${content.action.label}: ${url}`] : []),
    ...(content.footer ? [content.footer] : []),
    content.siteName,
  ].join('\n\n');

  const muted = 'color:#5b635d;font-size:13px';
  const html = [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f5f2;color:#1f2420;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;line-height:1.6">',
    '<div style="max-width:520px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">',
    `<p style="margin:0 0 24px;${muted}">${escapeHtml(content.siteName)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`),
    ...(content.action && url ? [
      `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f2420;color:#ffffff;text-decoration:none">${escapeHtml(content.action.label)}</a></p>`,
      `<p style="margin:0 0 16px;${muted};word-break:break-all">${escapeHtml(url)}</p>`,
    ] : []),
    ...(content.footer ? [`<p style="margin:24px 0 0;${muted}">${escapeHtml(content.footer)}</p>`] : []),
    '</div></body></html>',
  ].join('\n');

  return { html, text };
}
