import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import axe from 'axe-core';

// Keep reports of inconclusive checks: no violations is not a full accessibility certification.
// No rules or page regions are excluded, including color contrast and the preview itself.
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const summarize = (results) => results.map(({ id, impact, help, helpUrl, nodes }) => ({
  id, impact, help, helpUrl,
  nodes: nodes.map(({ target, html, failureSummary, any, all, none }) => ({
    target, html, failureSummary,
    checks: [...any, ...all, ...none].map(({ id, message, data }) => ({ id, message, data })),
  })),
}));

export async function accessibilityFlow(ctx, { newSession, signInOnPage, labelled }) {
  const { context, page } = await newSession(ctx);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scans = ctx.state.accessibility = [];
  let entryId;
  const scan = async (name) => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => { await document.fonts.ready; });
    // DevTools evaluation installs the test engine without changing the application's CSP.
    if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(axe.source);
    const result = await page.evaluate(async (tags) => window.axe.run(document, {
      runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'],
    }), tags);
    const record = {
      name, url: page.url(), viewport: page.viewportSize(), engine: result.testEngine,
      violations: summarize(result.violations), incomplete: summarize(result.incomplete),
    };
    scans.push(record);
    console.log(`A11Y  ${name}: ${record.violations.length} violation(s), ${record.incomplete.length} rule(s) need manual review`);
    if (record.violations.length && ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({ path: path.join(ctx.options.artifacts, `a11y-${name}.png`), fullPage: true });
    }
  };
  const visit = async (url, ready, name) => {
    await page.goto(url);
    await ready.waitFor();
    await scan(name);
  };
  const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
  const trapFocus = async (container) => {
    const controls = container.locator('a[href]:visible, button:not([disabled]):visible, input:not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible');
    assert.ok(await controls.count(), 'modal must have keyboard controls');
    await controls.last().focus();
    await page.keyboard.press('Tab');
    assert.ok(await focused(controls.first()), 'Tab must wrap from the last control to the first');
    await page.keyboard.press('Shift+Tab');
    assert.ok(await focused(controls.last()), 'Shift+Tab must wrap back to the last control');
  };
  try {
    await visit('/admin', page.getByRole('button', { name: 'Sign in', exact: true }), 'sign-in');
    await signInOnPage(page, ctx.options.adminEmail, ctx.options.adminPassword, 'accessibility admin');
    await scan('overview');
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await skip.focus();
    await scan('skip-link-focused');
    await page.keyboard.press('Enter');
    assert.ok(await focused(page.locator('main')), 'skip link must focus the main landmark');

    await visit('/admin/collections/posts', page.getByRole('heading', { name: 'Posts', exact: true }), 'posts');
    await visit('/admin/collections/posts/new', labelled(page, 'Title'), 'new-post');
    await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
    const summary = page.getByRole('alert', { name: 'Validation errors', exact: true });
    await summary.waitFor();
    assert.ok(await focused(summary), 'validation summary must receive focus');
    await scan('validation-errors');
    await summary.getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    assert.ok(await focused(labelled(page, 'Title')), 'error link must focus the invalid field');

    const created = await page.request.post('/admin/api/collections/posts/entries', {
      data: { slug: `a11y-${ctx.runId}`, data: { title: 'Accessibility confirmation fixture' } },
    });
    assert.ok(created.ok(), `create accessibility fixture: HTTP ${created.status()}`);
    entryId = (await created.json()).id;
    assert.ok(entryId, 'accessibility fixture must have an ID');
    await page.goto(`/admin/collections/posts/${entryId}`);
    const opener = page.getByRole('button', { name: 'Delete entry', exact: true });
    await opener.waitFor();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete entry?', exact: true });
    await dialog.waitFor();
    assert.ok(await focused(dialog.getByRole('button', { name: 'Cancel', exact: true })), 'destructive dialog must start on Cancel');
    await scan('delete-dialog');
    await trapFocus(dialog);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await focused(opener), 'Escape must return focus to the opener');

    await visit('/admin/globals/site-settings', labelled(page, 'Site Title'), 'globals');
    await page.route('**/admin/api/globals/site-settings', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, json: { error: 'Check the highlighted fields', fieldErrors: { title: ['Enter a site title'] } } })
      : route.continue());
    await labelled(page, 'Site Title').fill('Accessibility validation fixture');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const globalErrors = page.getByRole('alert', { name: 'Validation errors', exact: true });
    await globalErrors.waitFor();
    await scan('global-validation-errors');
    await globalErrors.getByRole('button', { name: 'Site Title', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.ok(await focused(labelled(page, 'Site Title')), 'global error link must focus the invalid field');
    await page.unroute('**/admin/api/globals/site-settings');

    await visit('/admin/media', page.getByRole('heading', { name: 'Media Library', exact: true }), 'media');
    await visit('/admin/extensions/analytics', page.locator('main h1, main h2').first(), 'analytics');
    await visit('/admin/extensions/commerce-attention', page.getByRole('heading', { name: 'Needs attention', exact: true }), 'commerce');

    // User palettes can intentionally fail contrast. Use a deterministic accessible palette to
    // check the editor AND preview without suppressing contrast rules or changing stored settings.
    const palette = (dark) => Object.fromEntries([
      ...['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'].flatMap((key) => [
        [key, dark ? '#eeeeee' : '#333333'], [`${key}-content`, dark ? '#111111' : '#ffffff'],
      ]),
      ...['base-100', 'base-200', 'base-300'].map((key) => [key, dark ? '#111111' : '#ffffff']),
      ['base-content', dark ? '#eeeeee' : '#111111'],
    ]);
    await page.route('**/admin/api/daisyui/theme', (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { version: 1, lightTheme: 'light', darkTheme: 'dark', lightColors: palette(false), darkColors: palette(true) } })
      : route.continue());
    await visit('/admin/extensions/daisyui-theme', page.getByRole('button', { name: 'Save Theme', exact: true }), 'theme-light');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.getByRole('region', { name: 'dark theme contrast', exact: true }).waitFor();
    await scan('theme-dark');

    await page.setViewportSize({ width: 375, height: 812 });
    await visit('/admin', page.getByRole('heading', { name: 'Overview', exact: true }), 'mobile-overview');
    const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await sidebar.waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await scan('mobile-drawer');
    await trapFocus(sidebar);
    await page.keyboard.press('Escape');
    await sidebar.waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(await focused(toggle), 'closing the drawer must return focus');
    await visit('/admin/collections/posts/new', labelled(page, 'Title'), 'mobile-editor');
    const failures = scans.flatMap(({ name, violations }) => violations.map((rule) => `${name}: ${rule.id} (${rule.nodes.length} node(s))`));
    assert.equal(failures.length, 0, `Accessibility violations: ${failures.join('; ')}`);
    return `${scans.length} WCAG A/AA scans; keyboard skip link, error focus, modal containment and focus restoration passed. Inconclusive checks are retained for manual review.`;
  } catch (error) {
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({ path: path.join(ctx.options.artifacts, 'a11y-interaction.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (entryId) await page.request.delete(`/admin/api/collections/posts/entries/${entryId}`).catch(() => {});
    await context.close();
    ctx.sessions = ctx.sessions.filter((session) => session !== context);
  }
}
