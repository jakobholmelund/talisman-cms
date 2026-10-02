import assert from 'node:assert/strict';

export function checkRenderedHtml(html) {
  assert.equal((html.match(/data-talisman-block="starwindSplitFeature"/g) || []).length, 4);
  assert.equal((html.match(/data-talisman-block="starwindMetricsBand"/g) || []).length, 2);
  assert.equal((html.match(/Year-over-year growth/g) || []).length, 4, 'preset props render in both slots and repeat instances');
  assert.match(html, /Standalone metric/);
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /Unknown (?:block|component)|data-talisman-ui-stub|\[object Object\]|href="(?:javascript|data|vbscript):|src="mailto:/i);
}

export async function checkBrowser(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(baseUrl);
    if (process.env.STARWIND_SCREENSHOT) await page.screenshot({ path: process.env.STARWIND_SCREENSHOT });
    assert.equal(await page.locator('#hostile img').count(), 0);
    assert.equal(await page.locator('#image-protocols img').count(), 0);
    assert.equal(await page.locator('#image-caption img').getAttribute('alt'), '<img src=x onerror="window.editorExecuted=true">');
    assert.equal(await page.locator('#hostile a').count(), 0, 'unsafe links become plain text');
    assert.equal(await page.locator('#urls a').count(), 9);
    assert.equal(await page.locator('#urls a[href="/invalid-label"]').count(), 0, 'malformed labels do not create empty links');
    assert.equal(await page.locator('img[alt="A geometric product illustration"]').count(), 2);
    assert.equal(await page.locator('a').first().getAttribute('href'), '#collection');
    assert.equal(await page.getByRole('link', { name: 'Explore collection' }).count(), 2);
    assert.equal(await page.getByRole('link', { name: 'Read details' }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'A useful collection' }).count(), 2);
    assert.equal(await page.evaluate(() => window.editorExecuted), undefined);
    // No generated IDs, duplicate IDs, or JS state to interfere with repeated sections.
    assert.deepEqual(await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]'), (node) => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    }), []);
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    assert.equal(await focused.textContent().then((text) => text.trim().replace(/\s+/g, ' ')), 'Explore collection→');
    assert.equal(await focused.evaluate((node) => getComputedStyle(node).outlineStyle), 'solid', 'keyboard focus indicator CSS is present');
    assert.equal(await focused.evaluate((node) => getComputedStyle(node).outlineWidth), '2px');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/#collection');
    // Source(none) makes this proof depend on the explicit packed renderer @source path.
    const section = page.locator('[data-talisman-block="starwindSplitFeature"] section').first();
    assert.equal(await section.evaluate((node) => getComputedStyle(node).paddingTop), '56px');
    assert.notEqual(await section.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    const inlineLink = page.locator('#standalone a');
    // Convert computed CSS colours to sRGB through canvas, then check WCAG normal-text contrast.
    for (const [selector, background] of [['#standalone a', 'white'], ['a', '#020617']]) {
      const contrast = await page.locator(selector).first().evaluate((node, background) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const luminance = (color) => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          const channels = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const values = [luminance(getComputedStyle(node).color), luminance(background)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      }, background);
      assert.ok(contrast >= 4.5, `${selector}: readable link contrast (${contrast.toFixed(2)}:1)`);
    }
    const standaloneColor = await inlineLink.evaluate((node) => getComputedStyle(node).color);
    assert.notEqual(standaloneColor, await page.locator('a').first().evaluate((node) => getComputedStyle(node).color), 'light and dark contexts receive different link colours');
    assert.equal(await page.locator('[data-talisman-block="starwindMetricsBand"] .grid').first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 4);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.locator('[data-talisman-block="starwindMetricsBand"] .grid').first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'long values and repeated compositions fit a narrow screen');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
