/**
 * Safe HTML for `richtext` fields. The admin editor stores Tiptap JSON, but the API accepts any
 * value, so the stored content is untrusted. The renderer escapes every text value and attribute,
 * outputs only the nodes and marks the editor produces, and drops links that are not http(s),
 * mailto, tel or relative. A string value is plain text, never HTML. The result is safe to pass to
 * Astro's `set:html`; never pass stored CMS content to `set:html` directly.
 */
interface RenderRichTextOptions {
    /**
     * Added to each heading level, so `1` renders the editor's Heading 1 as `<h2>` under the page's
     * own `<h1>`. Levels stop at `<h6>`. Default `0`.
     */
    headingOffset?: number;
}
declare function escapeHtml(value: string): string;
/** The link target when it is relative or uses http(s), mailto or tel; otherwise null. */
declare function safeRichTextHref(value: unknown): string | null;
/**
 * Render a stored `richtext` value as HTML. Tiptap JSON is rendered through the allowlist above; a
 * string is escaped and split into paragraphs at blank lines. Other values render nothing.
 */
declare function renderRichText(value: unknown, options?: RenderRichTextOptions): string;
/** The text of a stored `richtext` value on one line, for excerpts and meta descriptions. */
declare function richTextToPlainText(value: unknown): string;

export { type RenderRichTextOptions, escapeHtml, renderRichText, richTextToPlainText, safeRichTextHref };
