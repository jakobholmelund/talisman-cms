// Recovery UI uses controlled provider-free responses; conflicts exercise the real local API.
export async function commerceOpsFlow(ctx, { fail, expectVisible, expectHidden, expectValue, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  let accept = true;
  page.removeAllListeners('dialog');
  page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
  let failRead = true;
  let failRefresh = false;
  let held;
  const writes = [];
  let attachments = 0;
  const parked = [{ kind: 'order', id: 'review-order', createdAt: '2026-01-01T00:00:00Z', parkedAt: '2026-01-01T00:00:00Z',
    lastAttemptAt: null, attempts: 1, lastError: 'session_missing', problem: 'Session missing', provider: 'stripe', sessionMode: 'test', otherMode: false, amountCents: 1200, currency: 'usd' }];
  const tax = [{ kind: 'transaction', id: 'tax-order', orderId: 'tax-order', code: 'provider_refused', attempts: 3 }];
  const history = [];
  try {
    await page.route('**/api/ecommerce/fulfillment', route => json(route, { view: 'awaiting', pageSize: 50, awaitingCount: 0, nextCursor: null, orders: [] }));
    await page.route('**/api/ecommerce/reconcile', async route => {
      if (route.request().method() === 'GET') {
        if (failRead) return json(route, { error: 'Read unavailable' }, 503);
        if (failRefresh) { failRefresh = false; return json(route, { error: 'Read unavailable' }, 503); }
        return json(route, { storeMode: 'test', parkedCount: parked.length, parked, tax, history });
      }
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.action === 'retry') { held = route; return; }
      if (body.outcome === 'attach') return ++attachments === 1 ? json(route, { error: 'Attachment temporarily refused' }, 409) : json(route, null);
      tax.splice(0); history.push({ id: 'tax-decision', kind: 'tax_transaction', subjectId: 'tax-order', action: 'retry', reason: body.reason,
        actor: 'staff', actorName: 'Alex', createdAt: '2026-01-02T00:00:00Z', paymentReturned: null });
      failRefresh = true; return json(route, { result: {} });
    });
    await page.goto('/admin/extensions/commerce-orders');
    await expectVisible(page.getByRole('button', { name: 'Retry loading payment reviews', exact: true }), 'review read retry');
    failRead = false;
    await page.getByRole('button', { name: 'Retry loading payment reviews', exact: true }).click();
    const review = page.getByRole('region', { name: 'Payment review', exact: true });
    const reason = review.getByRole('textbox', { name: 'Reason for review-order', exact: true });
    await reason.fill('Checked the provider account');
    const taxReason = review.getByRole('textbox', { name: 'Reason for tax tax-order', exact: true });
    await taxReason.fill('Corrected the tax configuration');
    const providerId = review.getByRole('textbox', { name: 'Existing Stripe Tax record id', exact: true });
    await providerId.fill('tax_existing_fixture');
    await review.getByRole('button', { name: 'Attach existing record', exact: true }).click();
    await expectVisible(review.getByRole('alert').filter({ hasText: 'Attachment temporarily refused' }), 'failed tax attachment recovery');
    await expectValue(providerId, 'tax_existing_fixture', 'failed attachment preserves provider id');
    await review.getByRole('button', { name: 'Attach existing record', exact: true }).click();
    await expectVisible(review.getByRole('alert').filter({ hasText: 'The review response did not confirm a decision' }), 'malformed success remains unconfirmed');
    await expectValue(providerId, 'tax_existing_fixture', 'malformed response preserves attachment draft');
    await review.getByRole('button', { name: 'Retry', exact: true }).click();
    await waitUntil('held review write', async () => Boolean(held));
    await review.locator('form').first().getByRole('button', { name: 'Retry', exact: true }).evaluate(button => { button.disabled = false; button.click(); button.disabled = false; button.click(); });
    if (writes.length !== 3) fail('duplicate review action escaped the synchronous guard');
    parked.splice(0); history.push({ id: 'payment-decision', kind: 'order', subjectId: 'review-order', action: 'retry', reason: writes[2].reason,
      actor: 'staff', actorName: 'Alex', createdAt: '2026-01-02T00:00:00Z', paymentReturned: null });
    await held.abort(); held = null;
    await expectVisible(review.getByRole('alert').filter({ hasText: 'Your details are kept' }), 'lost decision response recovery');
    await expectValue(taxReason, 'Corrected the tax configuration', 'payment recovery preserves tax draft');
    await review.getByText('Recent review decisions', { exact: true }).click();
    await expectVisible(review.getByText('Alex', { exact: true }), 'recorded decision staff name');
    await expectVisible(review.getByText(/Checked the provider account/), 'recorded decision reason after lost response');
    await review.getByRole('button', { name: 'Retry after correcting cause', exact: true }).click();
    await expectVisible(review.getByRole('alert').filter({ hasText: 'Tax recovery recorded. The review list could not refresh' }), 'confirmed tax decision survives failed refresh');
    if (writes.length !== 4) fail('unexpected number of review writes');
    await review.getByRole('button', { name: 'Retry loading payment reviews', exact: true }).click();
    await expectHidden(review.getByRole('button', { name: 'Retry loading payment reviews', exact: true }), 'review read recovery');
    await review.getByRole('button', { name: 'Discard review drafts', exact: true }).click();
    await page.unroute('**/api/ecommerce/reconcile');
    await page.unroute('**/api/ecommerce/fulfillment');

    const api = '/admin/api/ecommerce/promotions';
    const code = `CONFLICT-${ctx.runId}`.slice(0, 32).toUpperCase();
    const input = { code, type: 'amount', value: 500, description: 'Original', maxDiscountCents: null, minOrderCents: 0,
      eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null, firstOrderOnly: false, startsAt: null, expiresAt: null, active: true };
    const createdResponse = await page.request.post(api, { data: { action: 'createCode', data: input }, headers: { origin: new URL(page.url()).origin } });
    if (!createdResponse.ok()) fail('local conflict fixture creation failed');
    await page.goto('/admin/extensions/commerce-promotions');
    const existing = page.getByRole('region', { name: 'Existing codes', exact: true });
    await existing.getByLabel('Find a code', { exact: true }).fill(code);
    await existing.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('region', { name: `Edit ${code}`, exact: true });
    await edit.getByLabel('Description', { exact: true }).fill('My preserved draft');
    const loaded = await (await page.request.get(api)).json();
    const current = loaded.codes.find(row => row.code === code);
    const saved = await page.request.post(api, { data: { action: 'updateCode', code, data: { ...input, description: 'Other administrator save', expectedVersion: Date.parse(current.updatedAt) / 1000 } }, headers: { origin: new URL(page.url()).origin } });
    if (!saved.ok()) fail('concurrent local save failed');
    await edit.getByRole('button', { name: 'Save code', exact: true }).click();
    await expectVisible(page.getByRole('button', { name: 'Load latest code', exact: true }), 'code conflict recovery');
    await expectValue(edit.getByLabel('Description', { exact: true }), 'My preserved draft', 'conflict keeps code draft');
    accept = false;
    await page.getByRole('button', { name: 'Load latest code', exact: true }).click();
    await expectValue(edit.getByLabel('Description', { exact: true }), 'My preserved draft', 'dismissed conflict reload keeps draft');
    accept = true;
    await page.getByRole('button', { name: 'Load latest code', exact: true }).click();
    await expectValue(edit.getByLabel('Description', { exact: true }), 'Other administrator save', 'explicit conflict reload adopts saved version');
    const referrals = page.getByRole('region', { name: 'Referral program', exact: true });
    await referrals.getByLabel('Reward per shopper (USD)', { exact: true }).fill('8');
    const currentPolicy = await (await page.request.get(api)).json();
    const policySave = await page.request.post(api, { data: { action: 'saveReferral', data: { expectedVersion: currentPolicy.referralRevision,
      enabled: false, rewardCents: 600, minOrderCents: 10000, attributionDays: 14 } }, headers: { origin: new URL(page.url()).origin } });
    if (!policySave.ok()) fail('concurrent referral save failed');
    await referrals.getByRole('button', { name: 'Save referral settings', exact: true }).click();
    await expectVisible(page.getByRole('button', { name: 'Load latest referral settings', exact: true }), 'referral conflict recovery');
    await expectValue(referrals.getByLabel('Reward per shopper (USD)', { exact: true }), '8', 'conflict keeps referral draft');
    await page.getByRole('button', { name: 'Load latest referral settings', exact: true }).click();
    await expectValue(referrals.getByLabel('Reward per shopper (USD)', { exact: true }), '6', 'explicit referral reload adopts saved version');
    if ((await (await page.request.get(api)).json()).referral.switchedOn) fail('conflict fixture enabled referrals');
    return 'review loading recovery, duplicate guard, lost committed response, independent drafts, tax refresh failure, recorded reasons and staff; real code and referral conflicts with explicit reload';
  } finally {
    if (held) await held.abort().catch(() => {});
    page.removeAllListeners('dialog'); await page.close();
  }
}
