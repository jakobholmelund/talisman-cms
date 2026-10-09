// Real local issuance checks include a committed write whose browser response is deliberately lost.
// Refund/review responses are controlled fixtures; no payment or email provider is contacted.
export async function giftCardFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  const endpoint = '**/api/ecommerce/gift-cards-admin';
  const api = '/admin/api/ecommerce/gift-cards-admin';
  const url = '/admin/extensions/commerce-gift-cards';
  const origin = { Origin: ctx.options.baseUrl };
  const attempts = [];
  const otherWrites = [];
  const issued = [];
  const reason = `Browser issuance ${ctx.runId}`;
  const prompts = [];
  let acceptPrompts = false;
  let readFailure = true;
  let loseFirstAnswer = true;
  let pending;
  let rejectNextIssue = false;
  let fixture;
  let reviewFailure = false;
  let failed = false;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const issuance = page.getByRole('region', { name: 'Issue a gift card', exact: true });
  const code = page.getByRole('textbox', { name: 'Private code', exact: true });
  const settle = () => expectHidden(page.getByRole('status').filter({ hasText: /^Loading gift cards/ }), 'gift-card load');
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => {
    prompts.push({ type: dialog.type(), message: dialog.message() });
    await (acceptPrompts ? dialog.accept() : dialog.dismiss());
  });
  try {
    await page.route(endpoint, async route => {
      if (route.request().method() === 'GET') {
        if (readFailure) { readFailure = false; return json(route, { error: 'Gift cards temporarily unavailable' }, 503); }
        if (fixture) return json(route, fixture);
        return route.continue();
      }
      const body = route.request().postDataJSON();
      if (body.action !== 'issue') {
        otherWrites.push(body);
        if (!fixture) return route.continue();
        if (body.action === 'resolveReview' && reviewFailure) {
          reviewFailure = false; fixture.reviews[0].refundedCents = 3000;
          return json(route, { error: 'The refund changed; review the latest total' }, 409);
        }
        if (body.action === 'resolveReview') { fixture.reviews = []; fixture.reviewCount = 0; return json(route, { result: {} }); }
        return json(route, { error: 'Refund temporarily unavailable' }, 400);
      }
      attempts.push(body.data);
      if (rejectNextIssue) { rejectNextIssue = false; return json(route, { error: 'Issuance temporarily refused' }, 400); }
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`Local gift-card issuance failed (${response.status()})`);
      const result = (await response.json()).result;
      if (!issued.some(row => row.id === result.id)) issued.push(result);
      if (loseFirstAnswer) { loseFirstAnswer = false; pending = route; return; }
      // Verify the screen still shows a confirmed code when its follow-up GET fails.
      if (attempts.length === 2) readFailure = true;
      return route.fulfill({ response });
    });
    await page.goto(url);
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Gift cards temporarily unavailable' }), 'initial gift-card read failure');
    const retryLoading = page.getByRole('button', { name: 'Retry loading gift cards', exact: true });
    if (await retryLoading.getAttribute('aria-disabled') !== 'false') fail('failed read did not offer an accessible loading retry');
    await retryLoading.click();
    await settle(); await expectNoAlert(page, 'gift-card retry');
    await issuance.getByLabel('Amount (USD)', { exact: true }).fill('25');
    await issuance.getByLabel('Reason', { exact: true }).fill(reason);
    await issuance.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await waitUntil('first issuance should commit with its answer held', async () => Boolean(pending));
    if (attempts.length !== 1 || !attempts[0].requestKey) fail('double submission was sent or issuance omitted its retry key');
    if (!await issuance.getByLabel('Reason', { exact: true }).evaluate(input => input.readOnly)) fail('pending issuance allowed its reason to change');
    await page.getByRole('link', { name: 'Commerce workspace', exact: true }).click();
    if (!prompts.at(-1)?.message.includes('retry key')) fail('pending issuance did not warn before leaving');
    if (new URL(page.url()).pathname !== url) fail('cancelled pending navigation left gift cards');
    await pending.abort(); pending = null;
    await expectVisible(page.getByRole('alert'), 'lost issuance answer');
    await expectValue(issuance.getByLabel('Reason', { exact: true }), reason, 'issuance details after lost answer');
    await issuance.getByRole('button', { name: 'Retry issuance', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Gift card issued. Copy the private code now. The gift-card list could not refresh' }), 'confirmed issuance with refresh failure');
    await expectValue(code, issued[0].code, 'recovered private code');
    if (attempts[0].requestKey !== attempts[1].requestKey || issued.length !== 1) fail('issuance retry created a different card');
    await issuance.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    if (attempts.length !== 2) fail('failed refresh allowed another issuance');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard refused'); } } }));
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'could not be copied automatically' }), 'copy failure guidance');
    if (!await code.evaluate(input => document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length)) fail('copy fallback did not select the private code');
    await page.reload({ timeout: 5000 }).catch(() => {});
    if (!prompts.some(prompt => prompt.type === 'beforeunload')) fail('unsaved code did not protect browser reload');
    await expectValue(code, issued[0].code, 'code retained after cancelled reload');
    await page.getByRole('button', { name: 'Retry loading gift cards', exact: true }).click();
    await settle();
    await expectVisible(page.getByRole('group', { name: `Gift card ${issued[0].id}`, exact: true }), 'issued card after list retry');
    const listed = await page.request.get(api);
    if (!listed.ok() || !listed.headers()['cache-control']?.includes('no-store')) fail('gift-card list contract failed');
    const data = await listed.json();
    if (data.cards.filter(row => row.adminReason === reason).length !== 1 || JSON.stringify(data).includes(attempts[0].requestKey)
      || JSON.stringify(data).includes(issued[0].code)) fail('issuance was duplicated or list disclosed private code/key');
    await issuance.getByLabel('Amount (USD)', { exact: true }).fill('10');
    await issuance.getByLabel('Reason', { exact: true }).fill(`${reason} second`);
    await issuance.getByRole('button', { name: 'Issue gift card', exact: true }).click();
    if (attempts.length !== 2 || !prompts.at(-1)?.message.includes('currently displayed private code')) fail('new issuance did not protect the displayed code');
    acceptPrompts = true; rejectNextIssue = true;
    await issuance.getByRole('button', { name: 'Issue gift card', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Issuance temporarily refused' }), 'new issuance refusal');
    await expectValue(code, issued[0].code, 'previous code after a new issuance fails');
    await issuance.getByRole('button', { name: 'Retry issuance', exact: true }).click();
    await waitUntil('new issuance should recover', async () => issued.length === 2);
    await expectValue(code, issued[1].code, 'second private code');
    await settle();
    if (attempts[2].requestKey !== attempts[3].requestKey || attempts[2].requestKey === attempts[0].requestKey) fail('new issuance did not get its own stable key');
    await page.getByRole('button', { name: 'I have saved this code', exact: true }).click();
    await expectVisible(page.getByRole('status').filter({ hasText: 'Private code marked as saved' }), 'manual code acknowledgment');
    // Review and refund controls use response fixtures; this part cannot move actual money or send email.
    fixture = { cards: [], encryption: data.encryption, reviewCount: 2, reviews: [
      { purchaseId: 'gp_review', amountCents: 10000, currency: 'usd', refundedCents: 2000, adjustedCents: 0, cardId: 'gift_review',
        codeSuffix: 'TEST', cardStatus: 'suspended', cardHeld: true, cardReplacement: false, balanceCents: 6000, spentCents: 4000, pendingCents: 0, replacementCount: 0 },
      { purchaseId: 'gp_held', amountCents: 10000, currency: 'usd', refundedCents: 5000, adjustedCents: 0, cardId: 'gift_held',
        codeSuffix: 'HELD', cardStatus: 'suspended', cardHeld: true, cardReplacement: false, balanceCents: 1000, spentCents: 9000, pendingCents: 1000, replacementCount: 0 },
    ] };
    await page.reload(); await settle();
    const held = page.getByRole('group', { name: 'Review gp_held', exact: true });
    await held.getByRole('textbox').fill('Review requires resolution');
    for (const button of await held.getByRole('button').all()) {
      if (await button.getAttribute('aria-disabled') !== 'true') fail('ineligible review action was enabled');
      await button.click({ force: true });
    }
    if (otherWrites.length) fail('ineligible review buttons sent a decision');
    const review = page.getByRole('group', { name: 'Review gp_review', exact: true });
    await review.getByRole('textbox').fill('Review refund total carefully');
    acceptPrompts = false;
    await review.getByRole('button', { name: 'Reinstate gp_review, less $20.00', exact: true }).click();
    if (otherWrites.length) fail('cancelled review recorded a decision');
    acceptPrompts = true; reviewFailure = true;
    await review.getByRole('button', { name: 'Reinstate gp_review, less $20.00', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'refund changed' }), 'stale refund decision');
    await expectValue(review.getByRole('textbox'), 'Review refund total carefully', 'review reason retained after stale refusal');
    await expectVisible(review.getByRole('button', { name: 'Reinstate gp_review, less $30.00', exact: true }), 'latest refund total');
    await review.getByRole('button', { name: 'Reinstate gp_review, less $30.00', exact: true }).click();
    await expectVisible(page.getByRole('status').filter({ hasText: 'review hold lifted' }), 'review decision confirmed');
    if (otherWrites[0].data.refundedCents !== 2000 || otherWrites[1].data.refundedCents !== 3000) fail('review did not use the latest refund guard');
    const refund = page.getByRole('region', { name: 'Gift-card payment refunds', exact: true }).locator('form').first();
    await refund.getByLabel('Order ID', { exact: true }).fill('ord_browser_refund');
    await refund.getByLabel('Gift card amount to restore (USD)', { exact: true }).fill('10');
    await refund.getByLabel('Reason', { exact: true }).fill('Restore returned order payment');
    acceptPrompts = false;
    await refund.getByRole('button', { name: 'Restore gift card amount', exact: true }).click();
    if (otherWrites.length !== 2 || !prompts.at(-1)?.message.includes('$10.00')) fail('refund confirmation omitted its amount or recorded on cancel');
    acceptPrompts = true;
    await refund.getByRole('button', { name: 'Restore gift card amount', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Refund temporarily unavailable' }), 'refund refusal');
    await expectValue(refund.getByLabel('Reason', { exact: true }), 'Restore returned order payment', 'refund reason retained after refusal');
    if (otherWrites[2].data.amountCents !== 1000) fail('refund amount was not sent in minor units');
    return 'real local lost-answer issuance, stable keys and one card; refresh/copy/code-leave recovery; controlled review and refund confirmations retain reasons and stale guards';
  } catch (cause) {
    failed = true; throw cause;
  } finally {
    if (pending) await pending.abort().catch(() => {});
    await page.unroute(endpoint);
    let cleanupError;
    for (const card of issued) {
      const response = await page.request.post(api, { headers: origin, data: { action: 'setActive', id: card.id, active: false } });
      if (!response.ok()) cleanupError = `gift-card fixture cleanup failed (${response.status()})`;
    }
    await page.close();
    if (!failed && cleanupError) fail(cleanupError);
  }
}
