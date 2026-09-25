import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRichText, richTextToPlainText, safeRichTextHref } from '../dist/richtext.js';

const doc = (...content) => ({ type: 'doc', content });
const paragraph = (...content) => ({ type: 'paragraph', content });
const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });

test('renders the nodes and marks the admin editor produces', () => {
  const html = renderRichText(doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
    paragraph(text('Bold', [{ type: 'bold' }]), text(' and '), text('both', [{ type: 'italic' }, { type: 'strike' }])),
    paragraph(text('u', [{ type: 'underline' }]), { type: 'hardBreak' }, text('x = 1', [{ type: 'code' }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('one'))] }] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph(text('three'))] }] },
    { type: 'blockquote', content: [paragraph(text('quoted'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
    { type: 'horizontalRule' },
    paragraph(),
  ));
  assert.equal(html, [
    '<h1>Title</h1>',
    '<p><strong>Bold</strong> and <s><em>both</em></s></p>',
    '<p><u>u</u><br><code>x = 1</code></p>',
    '<ul><li><p>one</p></li></ul>',
    '<ol start="3"><li><p>three</p></li></ol>',
    '<blockquote><p>quoted</p></blockquote>',
    '<pre><code class="language-ts">const a = 1;</code></pre>',
    '<hr>',
    '<p><br></p>',
  ].join(''));
});

test('escapes text so stored markup is shown, not run', () => {
  const html = renderRichText(doc(paragraph(text('<img src=x onerror=alert(1)> & "quotes"'))));
  assert.equal(html, '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;</p>');
  assert.equal(renderRichText('<script>alert(1)</script>\n\nSecond\nline'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>Second<br>line</p>');
});

test('drops unknown nodes, marks and attributes but keeps their text', () => {
  const html = renderRichText(doc(
    { type: 'iframe', attrs: { src: 'https://evil.example' }, content: [text('inside')] },
    paragraph(text('styled', [{ type: 'textStyle', attrs: { style: 'color:red' } }])),
    { type: 'paragraph', attrs: { class: 'x" onclick="alert(1)' }, content: [text('plain')] },
    { type: 'codeBlock', attrs: { language: 'js" onmouseover="alert(1)' }, content: [text('code')] },
    { type: 'orderedList', attrs: { start: '2" onclick="x' }, content: [] },
    { type: 'heading', attrs: { level: 9 }, content: [text('deep')] },
  ));
  assert.equal(html, 'inside<p>styled</p><p>plain</p><pre><code>code</code></pre><ol></ol><h6>deep</h6>');
  assert.equal(renderRichText(null), '');
  assert.equal(renderRichText(42), '');
  assert.equal(renderRichText({ type: 'doc', content: 'not-an-array' }), '');
});

test('links keep safe targets only', () => {
  const link = (href, attrs = {}) => renderRichText(paragraph(text('go', [{ type: 'link', attrs: { href, ...attrs } }])));
  assert.equal(link('https://example.com/a?b=1&c=2'), '<p><a href="https://example.com/a?b=1&amp;c=2">go</a></p>');
  assert.equal(link('/relative#part'), '<p><a href="/relative#part">go</a></p>');
  assert.equal(link('mailto:hello@example.com'), '<p><a href="mailto:hello@example.com">go</a></p>');
  assert.equal(link('https://example.com', { target: '_blank', rel: 'nofollow onmouseover=x' }),
    '<p><a href="https://example.com" target="_blank" rel="nofollow noopener noreferrer">go</a></p>');
  assert.equal(link('https://example.com', { target: 'frame' }), '<p><a href="https://example.com">go</a></p>');
  for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '', 42]) {
    assert.equal(link(href), '<p>go</p>', `kept ${JSON.stringify(href)}`);
  }
  assert.equal(link('"><script>alert(1)</script>'), '<p><a href="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">go</a></p>');
  assert.equal(safeRichTextHref('HTTPS://EXAMPLE.COM'), 'HTTPS://EXAMPLE.COM');
  assert.equal(safeRichTextHref('javascript&colon;alert(1)'), 'javascript&colon;alert(1)', 'entities stay escaped text, so this is a relative URL');
});

test('heading offset keeps the page outline and stops at h6', () => {
  const headings = doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('a')] },
    { type: 'heading', attrs: { level: 6 }, content: [text('b')] },
    { type: 'heading', content: [text('c')] },
  );
  assert.equal(renderRichText(headings, { headingOffset: 1 }), '<h2>a</h2><h6>b</h6><h2>c</h2>');
});

test('deeply nested documents stop at the depth limit', () => {
  let node = text('bottom');
  for (let index = 0; index < 5000; index++) node = { type: 'blockquote', content: [node] };
  const html = renderRichText(node);
  assert.ok(!html.includes('bottom'));
  assert.equal(html.match(/<blockquote>/g).length, 33);
  assert.equal(richTextToPlainText(node), '');
});

test('plain text joins blocks with spaces', () => {
  assert.equal(richTextToPlainText(doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
    paragraph(text('One '), text('two', [{ type: 'bold' }]), { type: 'hardBreak' }, text('three')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('<item>'))] }] },
  )), 'Title One two three <item>');
  assert.equal(richTextToPlainText('  line\n\n next '), 'line next');
  assert.equal(richTextToPlainText(undefined), '');
});
