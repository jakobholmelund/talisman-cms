import "./chunk-MLKGABMK.js";

// src/richtext.ts
var MAX_DEPTH = 32;
var SAFE_SCHEMES = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
var LINK_REL_TOKENS = /* @__PURE__ */ new Set(["noopener", "noreferrer", "nofollow", "ugc", "sponsored"]);
var CODE_LANGUAGE = /^[a-z0-9_+#-]{1,32}$/i;
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function safeRichTextHref(value) {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (!href) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.replace(/[\u0000- \u007f-\u009f]/g, ""));
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return href;
}
function isObject(value) {
  return Boolean(value) && typeof value === "object";
}
function linkAttributes(attrs) {
  const href = safeRichTextHref(attrs?.href);
  if (href === null) return null;
  const rel = new Set(typeof attrs?.rel === "string" ? attrs.rel.toLowerCase().split(/\s+/).filter((token) => LINK_REL_TOKENS.has(token)) : []);
  let html = ` href="${escapeHtml(href)}"`;
  if (attrs?.target === "_blank") {
    rel.add("noopener").add("noreferrer");
    html += ' target="_blank"';
  }
  if (rel.size) html += ` rel="${[...rel].join(" ")}"`;
  return html;
}
function renderText(node) {
  let html = escapeHtml(typeof node.text === "string" ? node.text : "");
  if (!Array.isArray(node.marks)) return html;
  for (const mark of node.marks) {
    if (!isObject(mark)) continue;
    switch (mark.type) {
      case "bold":
        html = `<strong>${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "underline":
        html = `<u>${html}</u>`;
        break;
      case "strike":
        html = `<s>${html}</s>`;
        break;
      case "code":
        html = `<code>${html}</code>`;
        break;
      case "link": {
        const attributes = linkAttributes(mark.attrs);
        if (attributes !== null) html = `<a${attributes}>${html}</a>`;
        break;
      }
    }
  }
  return html;
}
function renderNode(value, depth, options) {
  if (!isObject(value) || depth > MAX_DEPTH) return "";
  if (value.type === "text") return renderText(value);
  const children = Array.isArray(value.content) ? value.content.map((child) => renderNode(child, depth + 1, options)).join("") : "";
  switch (value.type) {
    case "doc":
      return children;
    case "paragraph":
      return `<p>${children || "<br>"}</p>`;
    case "heading": {
      const level = Math.trunc(Number(value.attrs?.level)) || 1;
      const offset = Math.trunc(Number(options.headingOffset)) || 0;
      const tag = `h${Math.min(6, Math.max(1, level + offset))}`;
      return `<${tag}>${children}</${tag}>`;
    }
    case "bulletList":
      return `<ul>${children}</ul>`;
    case "orderedList": {
      const start = Number(value.attrs?.start);
      return Number.isInteger(start) && start !== 1 ? `<ol start="${start}">${children}</ol>` : `<ol>${children}</ol>`;
    }
    case "listItem":
      return `<li>${children}</li>`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>`;
    case "codeBlock": {
      const language = value.attrs?.language;
      const className = typeof language === "string" && CODE_LANGUAGE.test(language) ? ` class="language-${language}"` : "";
      return `<pre><code${className}>${children}</code></pre>`;
    }
    case "hardBreak":
      return "<br>";
    case "horizontalRule":
      return "<hr>";
    // Unknown nodes keep their text but none of their own markup.
    default:
      return children;
  }
}
function renderRichText(value, options = {}) {
  if (typeof value === "string") {
    return value.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
  }
  return renderNode(value, 0, options);
}
function collectText(value, depth, parts) {
  if (!isObject(value) || depth > MAX_DEPTH) return;
  if (value.type === "text") {
    if (typeof value.text === "string") parts.push(value.text);
    return;
  }
  if (Array.isArray(value.content)) for (const child of value.content) collectText(child, depth + 1, parts);
  if (value.type !== "doc") parts.push(" ");
}
function richTextToPlainText(value) {
  const parts = [];
  if (typeof value === "string") parts.push(value);
  else collectText(value, 0, parts);
  return parts.join("").replace(/\s+/g, " ").trim();
}
export {
  escapeHtml,
  renderRichText,
  richTextToPlainText,
  safeRichTextHref
};
