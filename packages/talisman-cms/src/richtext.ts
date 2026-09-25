/**
 * Safe HTML for `richtext` fields. The admin editor stores Tiptap JSON, but the API accepts any
 * value, so the stored content is untrusted. The renderer escapes every text value and attribute,
 * outputs only the nodes and marks the editor produces, and drops links that are not http(s),
 * mailto, tel or relative. A string value is plain text, never HTML. The result is safe to pass to
 * Astro's `set:html`; never pass stored CMS content to `set:html` directly.
 */

export interface RenderRichTextOptions {
  /**
   * Added to each heading level, so `1` renders the editor's Heading 1 as `<h2>` under the page's
   * own `<h1>`. Levels stop at `<h6>`. Default `0`.
   */
  headingOffset?: number;
}

type RichNode = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; marks?: unknown; content?: unknown };

// Deeper content is dropped, so a crafted document cannot exhaust the stack.
const MAX_DEPTH = 32;
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const LINK_REL_TOKENS = new Set(['noopener', 'noreferrer', 'nofollow', 'ugc', 'sponsored']);
const CODE_LANGUAGE = /^[a-z0-9_+#-]{1,32}$/i;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** The link target when it is relative or uses http(s), mailto or tel; otherwise null. */
export function safeRichTextHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href) return null;
  // Browsers ignore tabs, newlines and other control characters inside a scheme ("java\tscript:").
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.replace(/[\u0000- \u007f-\u009f]/g, ''));
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return href;
}

function isObject(value: unknown): value is RichNode {
  return Boolean(value) && typeof value === 'object';
}

function linkAttributes(attrs: Record<string, unknown> | undefined): string | null {
  const href = safeRichTextHref(attrs?.href);
  if (href === null) return null;
  const rel = new Set(typeof attrs?.rel === 'string'
    ? attrs.rel.toLowerCase().split(/\s+/).filter((token) => LINK_REL_TOKENS.has(token))
    : []);
  let html = ` href="${escapeHtml(href)}"`;
  if (attrs?.target === '_blank') {
    rel.add('noopener').add('noreferrer');
    html += ' target="_blank"';
  }
  if (rel.size) html += ` rel="${[...rel].join(' ')}"`;
  return html;
}

function renderText(node: RichNode): string {
  let html = escapeHtml(typeof node.text === 'string' ? node.text : '');
  if (!Array.isArray(node.marks)) return html;
  for (const mark of node.marks) {
    if (!isObject(mark)) continue;
    switch (mark.type) {
      case 'bold': html = `<strong>${html}</strong>`; break;
      case 'italic': html = `<em>${html}</em>`; break;
      case 'underline': html = `<u>${html}</u>`; break;
      case 'strike': html = `<s>${html}</s>`; break;
      case 'code': html = `<code>${html}</code>`; break;
      case 'link': {
        const attributes = linkAttributes(mark.attrs);
        if (attributes !== null) html = `<a${attributes}>${html}</a>`;
        break;
      }
    }
  }
  return html;
}

function renderNode(value: unknown, depth: number, options: RenderRichTextOptions): string {
  if (!isObject(value) || depth > MAX_DEPTH) return '';
  if (value.type === 'text') return renderText(value);
  const children = Array.isArray(value.content)
    ? value.content.map((child) => renderNode(child, depth + 1, options)).join('')
    : '';
  switch (value.type) {
    case 'doc': return children;
    case 'paragraph': return `<p>${children || '<br>'}</p>`;
    case 'heading': {
      const level = Math.trunc(Number(value.attrs?.level)) || 1;
      const offset = Math.trunc(Number(options.headingOffset)) || 0;
      const tag = `h${Math.min(6, Math.max(1, level + offset))}`;
      return `<${tag}>${children}</${tag}>`;
    }
    case 'bulletList': return `<ul>${children}</ul>`;
    case 'orderedList': {
      const start = Number(value.attrs?.start);
      return Number.isInteger(start) && start !== 1 ? `<ol start="${start}">${children}</ol>` : `<ol>${children}</ol>`;
    }
    case 'listItem': return `<li>${children}</li>`;
    case 'blockquote': return `<blockquote>${children}</blockquote>`;
    case 'codeBlock': {
      const language = value.attrs?.language;
      const className = typeof language === 'string' && CODE_LANGUAGE.test(language) ? ` class="language-${language}"` : '';
      return `<pre><code${className}>${children}</code></pre>`;
    }
    case 'hardBreak': return '<br>';
    case 'horizontalRule': return '<hr>';
    // Unknown nodes keep their text but none of their own markup.
    default: return children;
  }
}

/**
 * Render a stored `richtext` value as HTML. Tiptap JSON is rendered through the allowlist above; a
 * string is escaped and split into paragraphs at blank lines. Other values render nothing.
 */
export function renderRichText(value: unknown, options: RenderRichTextOptions = {}): string {
  if (typeof value === 'string') {
    return value.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
      .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
  }
  return renderNode(value, 0, options);
}

function collectText(value: unknown, depth: number, parts: string[]) {
  if (!isObject(value) || depth > MAX_DEPTH) return;
  if (value.type === 'text') {
    if (typeof value.text === 'string') parts.push(value.text);
    return;
  }
  if (Array.isArray(value.content)) for (const child of value.content) collectText(child, depth + 1, parts);
  // Text runs inside a block join directly; blocks and line breaks are separated by a space.
  if (value.type !== 'doc') parts.push(' ');
}

/** The text of a stored `richtext` value on one line, for excerpts and meta descriptions. */
export function richTextToPlainText(value: unknown): string {
  const parts: string[] = [];
  if (typeof value === 'string') parts.push(value);
  else collectText(value, 0, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
