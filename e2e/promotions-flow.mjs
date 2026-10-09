// Real local promotion saves with deliberately lost responses and failed follow-up reads.
export async function promotionsFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  const endpoint = '**/api/ecommerce/promotions';
  const url = '/admin/extensions/commerce-promotions';
  const attempts = [];
  const answers = [];
  const prompts = [];
  let acceptPrompts = false;
  let readFailure = true;
  let loseAnswer = true;
  let pending;
  let rejectUpdate = true;
  let rejectReferral = true;
  let rejectCreation = false;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const create = () => page.getByRole('region', { name: 'Create discount or credit code', exact: true });
  const referrals = page.getByRole('region', { name: 'Referral program', exact: true });
  const existing = page.getByRole('region', { name: 'Existing codes', exact: true });
  const retry = page.getByRole('button', { name: 'Retry loading promotions', exact: true });
  const settle = () => expectHidden(page.getByRole('status').filter({ hasText: /^(Loading promotions|Saving promotion changes)/ }), 'promotion request settlement');
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => { prompts.push({ type: dialog.type(), message: dialog.message() }); await (acceptPrompts ? dialog.accept() : dialog.dismiss()); });
  try {
    await page.route(endpoint, async route => {
      if (route.request().method() === 'GET') {
        if (readFailure) { readFailure = false; return json(route, { error: 'Promotions temporarily unavailable' }, 503); }
        return route.continue();
      }
      const body = route.request().postDataJSON();
      attempts.push(body);
      if (body.action === 'createCode' && rejectCreation) { rejectCreation = false; return json(route, { error: 'Creation temporarily refused' }, 400); }
      if (body.action === 'updateCode' && rejectUpdate) { rejectUpdate = false; return json(route, { error: 'Code update temporarily refused' }, 400); }
      if (body.action === 'saveReferral' && rejectReferral) { rejectReferral = false; return json(route, { error: 'Referral update temporarily refused' }, 400); }
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`Local promotion save failed (${response.status()}): ${await response.text()}`);
      const result = (await response.json()).result;
      if (body.action === 'createCode') {
        answers.push(result);
        if (loseAnswer) { loseAnswer = false; pending = route; return; }
      }
      readFailure = true;
      return route.fulfill({ response });
    });
    await page.goto(url);
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Promotions temporarily unavailable' }), 'initial promotion load error');
    await retry.click(); await settle(); await expectNoAlert(page, 'promotion loading retry');
    await referrals.getByLabel('Reward per shopper (USD)', { exact: true }).fill('7');
    await create().getByLabel('Type', { exact: true }).selectOption('credit');
    await create().getByLabel('Value (USD)', { exact: true }).fill('25');
    await create().getByLabel('Description', { exact: true }).fill(`Credit ${ctx.runId}`);
    await create().locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await waitUntil('creation should commit with answer held', async () => Boolean(pending));
    if (attempts.length !== 1 || !attempts[0].data.requestKey) fail('double creation was sent or retry key was omitted');
    if (!await create().getByLabel('Description', { exact: true }).isDisabled()) fail('creation details remained editable while awaiting confirmation');
    await page.getByRole('link', { name: 'Commerce workspace', exact: true }).click();
    if (!prompts.at(-1)?.message.includes('retry key') || new URL(page.url()).pathname !== url) fail('pending creation navigation was not protected');
    await pending.abort(); pending = null;
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Creation has not been confirmed' }), 'lost creation answer');
    await page.reload({ timeout: 5000 }).catch(() => {});
    if (!prompts.some(prompt => prompt.type === 'beforeunload')) fail('unconfirmed creation did not protect reload');
    await create().getByRole('button', { name: 'Retry creation', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'saved. The promotion list could not refresh' }), 'confirmed creation despite refresh failure');
    const creationAttempts = attempts.filter(item => item.action === 'createCode');
    if (creationAttempts.length !== 2 || JSON.stringify(creationAttempts[0]) !== JSON.stringify(creationAttempts[1]) || answers[0].code !== answers[1].code) fail('creation retry changed the original request or created another voucher');
    await expectValue(create().getByLabel('Description', { exact: true }), '', 'confirmed creation resets description');
    await expectValue(create().getByLabel('Value (USD)', { exact: true }), '', 'confirmed creation resets value');
    await expectValue(referrals.getByLabel('Reward per shopper (USD)', { exact: true }), '7', 'creation preserves referral draft');
    await create().locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    if (attempts.length !== 2) fail('failed refresh permitted another write');
    await retry.click(); await settle();
    const real = await page.request.get('/admin/api/ecommerce/promotions');
    const data = await real.json();
    if (data.codes.filter(code => code.description === `Credit ${ctx.runId}`).length !== 1) fail('lost response duplicated a credit voucher');
    await create().getByLabel('Code', { exact: true }).fill(`DRAFT-${ctx.runId}`.slice(0, 32));
    await create().getByLabel('Value (USD)', { exact: true }).fill('3');
    await existing.getByLabel('Find a code', { exact: true }).fill(answers[0].code);
    await existing.getByRole('button', { name: 'Edit', exact: true }).click();
    if (!prompts.at(-1)?.message.includes('Discard') || await create().count() !== 1) fail('switching codes lost an unsaved draft without consent');
    await expectValue(create().getByLabel('Value (USD)', { exact: true }), '3', 'cancelled switch retains draft');
    acceptPrompts = true;
    await existing.getByRole('button', { name: 'Edit', exact: true }).click();
    acceptPrompts = false;
    const edit = page.getByRole('region', { name: `Edit ${answers[0].code}`, exact: true });
    await edit.getByLabel('Description', { exact: true }).fill(`Edited ${ctx.runId}`);
    await edit.getByRole('button', { name: 'Save code', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Code update temporarily refused' }), 'code update error');
    await expectValue(edit.getByLabel('Description', { exact: true }), `Edited ${ctx.runId}`, 'failed code update retains draft');
    await page.getByRole('link', { name: 'Commerce workspace', exact: true }).click();
    if (!prompts.at(-1)?.message.includes('unsaved') || new URL(page.url()).pathname !== url) fail('unsaved promotion drafts did not protect navigation');
    await edit.getByRole('button', { name: 'Save code', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'saved. The promotion list could not refresh' }), 'confirmed code update despite refresh failure');
    await retry.click(); await settle();
    await referrals.getByLabel('Enable new referral awards', { exact: true }).uncheck();
    await referrals.getByRole('button', { name: 'Save referral settings', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Referral update temporarily refused' }), 'referral update error');
    await expectValue(referrals.getByLabel('Reward per shopper (USD)', { exact: true }), '7', 'failed referral save retains draft');
    await create().getByLabel('Description', { exact: true }).fill('Keep this code draft');
    await referrals.getByRole('button', { name: 'Save referral settings', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Referral settings saved. The promotion list could not refresh' }), 'confirmed referral save despite refresh failure');
    await expectValue(create().getByLabel('Description', { exact: true }), 'Keep this code draft', 'referral save preserves code draft');
    await retry.click(); await settle();
    const saved = await (await page.request.get('/admin/api/ecommerce/promotions')).json();
    if (saved.referral.switchedOn || saved.referral.rewardCents !== 700) fail('referral save did not preserve the off switch and edited reward');
    await create().getByLabel('Type', { exact: true }).selectOption('credit');
    await create().getByLabel('Value (USD)', { exact: true }).fill('4');
    rejectCreation = true;
    await create().getByRole('button', { name: 'Create code', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Creation temporarily refused' }), 'refused creation retains recovery state');
    await create().getByRole('button', { name: 'Cancel creation retry', exact: true }).click();
    if (!prompts.at(-1)?.message.includes('does not undo')) fail('cancelling retry did not explain possible committed creation');
    await expectVisible(create().getByRole('button', { name: 'Retry creation', exact: true }), 'dismissed cancellation keeps retry');
    acceptPrompts = true;
    await create().getByRole('button', { name: 'Cancel creation retry', exact: true }).click();
    await expectValue(create().getByLabel('Description', { exact: true }), 'Keep this code draft', 'cancelled creation retry preserves editable draft');
    await expectValue(create().getByLabel('Value (USD)', { exact: true }), '4', 'cancelled creation retry preserves amount');
    await create().getByRole('button', { name: 'Discard code draft', exact: true }).click();
    acceptPrompts = false;
    await page.getByRole('link', { name: 'Commerce workspace', exact: true }).click();
    await page.waitForURL(candidate => candidate.pathname === '/admin/commerce');
    const requestCount = prompts.length;
    if (prompts.at(-1)?.message.includes('Leave promotions')) fail('saved/discarded drafts still blocked navigation');
    return `real creation and editing; lost answer retries one voucher, double-submit guard, failed reads/saves, independent drafts, ${requestCount} navigation/reload/discard checks; referrals stay off`;
  } finally {
    if (pending) await pending.abort().catch(() => {});
    page.removeAllListeners('dialog');
    await page.close();
  }
}
