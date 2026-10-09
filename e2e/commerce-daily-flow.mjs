import { mkdir } from 'node:fs/promises';
// Daily operations: real local stock reads and provider-free failure/retry rehearsals.
export async function commerceDailyFlow(ctx, { fail, expectVisible, expectHidden, expectValue, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  async function capture(name) { if (ctx.options.artifacts) { await mkdir(ctx.options.artifacts, {recursive:true}); await page.screenshot({path:`${ctx.options.artifacts}/${name}.png`,fullPage:true}); } }
  page.removeAllListeners('dialog');
  let accept = true;
  page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  let failRead = true;
  let held;
  let failRefresh = false;
  let malformed = true;
  const writes = [];
  const rows = [{ id: 'email-fixture', kind: 'order_confirmation', subjectId: 'order-fixture', status: 'failed', attempts: 10,
    lastError: 'expired', nextAttemptAt: '2026-01-01T00:00:00Z', claimedAt: null, retryRequestId: null,
    createdAt: '2026-01-01T00:00:00Z', retryable: true, guidance: 'Resolve the recorded error, then request a new delivery attempt.' }];
  const history = [];
  const attention = { checkedAt: '2026-01-01T00:00:00Z', counts: { email: 52, gift_hold: 1 },
    rows: [{ kind: 'email', id: 'email-fixture', subject: 'order_confirmation', createdAt: '2026-01-01T00:00:00Z', detail: 'expired' }] };
  const payloads = [];
  let componentId;
  try {
    const fixture = await page.request.post('/admin/api/collections/_ecommerce_components/entries', { headers: { Origin: ctx.options.baseUrl }, data: { data: { sku: `DAILY-${ctx.runId}`, name: 'Daily stock fixture', quantity: 3 } } });
    if (!fixture.ok()) fail(`component fixture creation failed: ${fixture.status()} ${await fixture.text()}`);
    componentId = (await fixture.json()).id;
    await page.route('**/api/ecommerce/operations?*', async route => {
      const request = route.request();
      const query = new URL(request.url()).searchParams;
      if (query.get('view') === 'stock') { payloads.push(query); return route.continue(); }
      if (failRead) return json(route, { error: 'Read unavailable' }, 503);
      if (failRefresh) { failRefresh = false; return json(route, { error: 'Refresh unavailable' }, 503); }
      return json(route, query.get('view') === 'attention' ? attention : { rows, history, total: rows.length, offset: 0 });
    });
    await page.route('**/api/ecommerce/operations', async route => {
      const body = route.request().postDataJSON(); writes.push(body);
      if (writes.length === 1) return json(route, { error: 'This email changed. Reload its latest status.' }, 409);
      if (writes.length === 2) { held = route; return; }
      if (malformed) { malformed = false; return json(route, { result: null }); }
      history.push({ id: 'receipt-fixture', emailId: body.data.emailId, actor: 'staff', actorName: 'Alex', reason: body.data.reason,
        priorAttempts: 10, priorError: 'expired', createdAt: '2026-01-02T00:00:00Z' });
      failRefresh = true;
      return json(route, { result: { decisionId: 'receipt-fixture', emailId: body.data.emailId, delivery: { status: 'pending' } } });
    });
    await page.goto('/admin/extensions/commerce-attention');
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Read unavailable' }), 'attention read failure');
    failRead = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'Email problems (52)', exact: true }), 'exact attention count');
    await expectVisible(page.getByRole('heading', { name: 'Held gift cards (1)', exact: true }), 'held card attention count');
    await capture('commerce-attention');
    await page.getByRole('link', { name: 'Open email recovery', exact: true }).click();
    const email = page.getByRole('region', { name: 'Email email-fixture', exact: true });
    const reason = email.getByRole('textbox', { name: 'Reason for retry', exact: true });
    await reason.fill('Resolved the sender configuration');
    await capture('commerce-email-recovery');
    accept = false;
    await page.getByRole('link', { name: 'Stock overview', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'Email recovery', exact: true }), 'unsaved reason blocks navigation');
    accept = true;
    await email.getByRole('button', { name: 'Request retry', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'This email changed' }), 'stale retry refusal');
    await expectValue(reason, 'Resolved the sender configuration', 'stale retry preserves reason');
    if (!await email.getByRole('button', { name: 'Request retry', exact: true }).isDisabled()) fail('stale email retry stayed writable');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await email.getByRole('button', { name: 'Request retry', exact: true }).click();
    await waitUntil('held email retry', async () => !!held);
    await email.getByRole('button', { name: 'Request retry', exact: true }).evaluate(button => { button.disabled = false; button.click(); button.disabled = false; button.click(); });
    if (writes.length !== 2) fail('duplicate email retry escaped synchronous guard');
    rows.splice(0); await held.abort(); held = null;
    await expectVisible(page.getByRole('region', { name: 'Unconfirmed retry', exact: true }), 'lost email retry response');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectVisible(page.getByText('No email problems are recorded.', { exact: true }), 'refresh after queue change');
    await expectVisible(page.getByRole('region', { name: 'Retained email drafts', exact: true }), 'off-page reason retained');
    await page.getByRole('button', { name: 'Recover same retry', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'response was incomplete' }), 'malformed receipt does not clear retry');
    await page.getByRole('button', { name: 'Recover same retry', exact: true }).click();
    await expectHidden(page.getByRole('region', { name: 'Unconfirmed retry', exact: true }), 'confirmed email retry clears frozen request');
    await expectVisible(page.getByRole('status').filter({ hasText: 'Retry recorded for email-fixture' }), 'queue receipt survives failed refresh');
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Refresh unavailable' }), 'failed post-save refresh');
    if (writes.length !== 4 || writes.slice(1).some(write => JSON.stringify(write) !== JSON.stringify(writes[1]))) fail('retry recovery changed its original key or payload');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectVisible(page.getByRole('region', { name: 'Email recovery history', exact: true }).getByText('Resolved the sender configuration'), 'named recovery history');
    await expectHidden(page.getByRole('region', { name: 'Retained email drafts', exact: true }), 'confirmed reason cleared');
    await page.getByRole('link', { name: 'Stock overview', exact: true }).click();
    await expectVisible(page.getByRole('region', { name: 'Stock filters', exact: true }), 'stock filter screen');
    const filters = page.getByRole('region', { name: 'Stock filters', exact: true });
    await filters.getByLabel('Show', { exact: true }).selectOption('all');
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expectVisible(page.getByRole('link', { name: 'Edit product', exact: true }).first(), 'stock links to product editor');
    const target = await page.getByRole('link', { name: 'Edit product', exact: true }).first().getAttribute('href');
    if (!target?.startsWith('/admin/commerce/products/')) fail(`stock editor link uses wrong path: ${target}`);
    await filters.getByLabel('Inventory', { exact: true }).selectOption('components');
    await filters.getByLabel('Low stock threshold', { exact: true }).fill('7');
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'Shared component stock', exact: true }), 'component stock view');
    await expectVisible(page.getByRole('link', { name: 'Edit component', exact: true }).first(), 'component stock editor link');
    await capture('commerce-stock');
    await page.setViewportSize({width:390,height:844});
    const closeMenu = page.getByRole('button', {name:'Close navigation menu',exact:true});
    await expectHidden(closeMenu, 'closed mobile navigation after resize');
    await capture('commerce-stock-mobile-filters');
    await page.getByRole('heading', {name:'Shared component stock',exact:true}).scrollIntoViewIfNeeded();
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('stock overview overflows the mobile page');
    await capture('commerce-stock-mobile');
    const query = payloads.at(-1);
    if (query?.get('inventory') !== 'components' || query.get('threshold') !== '7') fail('stock filters were not sent to the server');
    await page.getByRole('link', { name: 'Edit component', exact: true }).first().click();
    await expectVisible(page.getByLabel('Available Quantity', { exact: true }), 'stock link opens component adjustment field');
    return 'Daily attention, guarded email retry recovery, named history, and stock/component editor links passed.';
  } catch (cause) { await capture('commerce-daily-active-failure'); console.error('Daily flow failure at', page.url(), await page.getByRole('combobox').evaluateAll(elements => elements.map(element => ({name:element.name, label:element.getAttribute('aria-label'), labels:Array.from(element.labels || []).map(label => label.textContent)})))); throw cause; } finally { if (held) await held.abort(); if (componentId) await page.request.delete(`/admin/api/collections/_ecommerce_components/entries/${componentId}`, { headers: { Origin: ctx.options.baseUrl } }); await page.close(); }
}
