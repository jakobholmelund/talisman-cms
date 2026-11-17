import { mkdir } from 'node:fs/promises';

export async function commerceTriageFlow(ctx, { fail, expectVisible, expectHidden, expectValue, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  page.removeAllListeners('dialog');
  page.on('dialog', dialog => dialog.dismiss());
  const orderId = 'ord_55555555-5555-4555-8555-555555555555';
  const checkedAt = '2026-10-10T00:00:00Z';
  const rows = Array.from({ length: 10 }, (_, n) => ({ kind: 'email', id: `email-${n}`, subject: 'order_confirmation', createdAt: `2026-10-0${Math.min(n + 1, 9)}T00:00:00Z`, detail: 'Sender needs review' }));
  rows.push({ kind: 'inspection', id: 'recovery-return', subject: 'Received return', createdAt: '2026-09-01T00:00:00Z', detail: orderId },
    { kind: 'refund', id: 'recovery-return', subject: 'Return refund', createdAt: '2026-09-02T00:00:00Z', detail: orderId },
    { kind: 'return_request', id: 'triage-request', subject: 'Return request', createdAt: '2026-09-03T00:00:00Z', detail: orderId },
    { kind: 'parcel_recovery', id: 'triage-case', subject: 'Parcel or exchange', createdAt: '2026-09-04T00:00:00Z', detail: 'exchange · 1 units' });
  let snapshot = { checkedAt, counts: { email: 52, inspection: 1, refund: 1, return_request: 1, parcel_recovery: 1 }, rows };
  let failed = false;
  const reads = [], writes = [];
  const capture = async name => { if (ctx.options.artifacts) { await mkdir(ctx.options.artifacts, { recursive: true }); await page.screenshot({ path: `${ctx.options.artifacts}/${name}.png`, fullPage: true }); } };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  try {
    await page.route('**/api/ecommerce/operations?*', route => new URL(route.request().url()).searchParams.get('view') === 'attention'
      ? json(route, failed ? { error: 'Snapshot unavailable' } : snapshot, failed ? 503 : 200) : route.continue());
    await page.route('**/api/ecommerce/operations', route => {
      const body = route.request().postDataJSON();
      if (['returnRequestRead', 'recoveryRead', 'warehouseRead', 'refundRead'].includes(body.action)) {
        reads.push(body);
        if (['returnRequestRead', 'recoveryRead'].includes(body.action)) return json(route, { error: 'Record no longer available' }, 403);
        return route.continue();
      }
      writes.push(body); return route.continue();
    });
    await page.goto('/admin/extensions/commerce-attention');
    const areas = page.getByLabel('Work areas', { exact: true });
    await expectVisible(areas.getByRole('button', { name: 'All work 56 queue tasks', exact: true }), 'complete task count');
    await expectHidden(page.getByRole('region', { name: 'Awaiting shipment', exact: true }), 'clear queues hidden');
    const titles = await page.locator('.ecom-admin__attention .ecom-admin__grid h2').allTextContents();
    if (titles[0] !== 'Pending inspections (1)') fail('oldest queue was not first');
    await areas.getByRole('button', { name: 'Customer emails 52 queue tasks', exact: true }).click();
    await expectHidden(page.getByRole('region', { name: 'Pending inspections', exact: true }), 'area filters out other work');
    await expectVisible(page.getByText('9d in queue', { exact: true }), 'snapshot-relative age');
    await expectHidden(page.getByText('email-9', { exact: true }), 'bounded preview collapsed');
    await page.getByText('Show 7 more preview records', { exact: true }).click();
    await expectVisible(page.getByText('email-9', { exact: true }), 'remaining bounded preview');
    await expectVisible(page.getByText('10 of 52 queue records in this preview.', { exact: false }), 'sample distinguished from total');
    await areas.getByRole('button', { name: 'Shipping 0 queue tasks', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'This work area is clear', exact: true }), 'empty work area');
    await page.getByLabel('Show clear queues', { exact: true }).check();
    await expectVisible(page.getByRole('heading', { name: 'Awaiting shipment (0)', exact: true }), 'clear queue opt-in');
    await page.getByLabel('Show clear queues', { exact: true }).uncheck();
    await areas.getByRole('button', { name: 'All work 56 queue tasks', exact: true }).click();
    failed = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Displayed records may be out of date' }), 'stale refresh warning');
    await expectVisible(areas.getByRole('button', { name: 'All work 56 queue tasks', exact: true }), 'snapshot retained on failure');
    failed = false;
    snapshot = { ...snapshot, counts: { email: '52' } };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'incomplete operations response' }), 'malformed counts refused');
    snapshot = { checkedAt, counts: { email: 52, inspection: 1, refund: 1, return_request: 1, parcel_recovery: 1 }, rows };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitUntil('fresh attention snapshot', () => page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled());
    await expectHidden(page.getByRole('alert'), 'fresh snapshot recovered');
    await capture('commerce-triage-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectHidden(page.getByRole('button', { name: 'Close navigation menu', exact: true }), 'mobile navigation settled');
    await waitUntil('mobile dashboard fits viewport', () => page.locator('.ecom-admin__attention').evaluate(node => node.getBoundingClientRect().right <= window.innerWidth + 1));
    await capture('commerce-triage-mobile');
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('triage overflows mobile width');
    const mobile = await page.locator('.ecom-admin__attention').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    if (mobile.content > mobile.width + 1) fail(`triage content overflows its mobile container: ${JSON.stringify(mobile)}`);
    const open = id => page.getByRole('link', { name: `Open case · ${id}`, exact: true });
    await open('triage-request').click();
    await expectVisible(page.getByRole('region', { name: 'Return request triage-request', exact: true }).getByRole('alert'), 'return target freshly refused');
    if (!reads.some(r => r.action === 'returnRequestRead' && r.data.requestId === 'triage-request')) fail('wrong return target read');
    await page.getByRole('link', { name: 'Needs attention', exact: true }).click();
    await open('triage-case').click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Record no longer available' }), 'recovery target freshly refused');
    if (!reads.some(r => r.action === 'recoveryRead' && r.data.caseId === 'triage-case')) fail('wrong recovery target read');
    await page.getByRole('link', { name: 'Needs attention', exact: true }).click();
    await page.getByRole('region', { name: 'Pending inspections', exact: true }).getByRole('link', { name: 'Open case · recovery-return', exact: true }).click();
    await expectVisible(page.getByRole('region', { name: 'Inspection recovery-return', exact: true }).getByText('Inspection complete', { exact: true }), 'actual inspection target loaded');
    await page.getByRole('link', { name: 'Needs attention', exact: true }).click();
    await page.getByRole('region', { name: 'Return refund follow-up', exact: true }).getByRole('link', { name: 'Open case · recovery-return', exact: true }).click();
    await expectVisible(page.getByRole('region', { name: 'Return refund details', exact: true }).getByText(`Order ${orderId}`, { exact: false }), 'actual refund target loaded');
    await waitUntil('focused case details', () => page.locator('.ecom-admin__selected-case').evaluate(node => node === document.activeElement));
    await capture('commerce-triage-refund-mobile');
    if (writes.length) fail('opening attention cases performed a write');
    const reason = page.getByRole('form', { name: 'Return refund decision', exact: true }).getByLabel('Internal reason', { exact: true });
    await reason.fill('Keep this follow-up draft while reviewing');
    await page.getByRole('link', { name: 'Needs attention', exact: true }).click();
    await expectValue(reason, 'Keep this follow-up draft while reviewing', 'declined navigation retains case draft');
    if (!page.url().includes('/commerce-refunds')) fail('case draft did not block navigation');
    await page.getByRole('button', { name: 'Discard refund draft', exact: true }).click();
    await page.goto('/admin/extensions/commerce-recoveries#kind=recovery&id=bad%20reference');
    await expectHidden(page.getByRole('heading', { name: 'Recovery case bad reference', exact: true }), 'invalid fragment ignored');
    if (reads.some(r => r.data?.caseId === 'bad reference')) fail('invalid fragment was sent to protected API');
    await page.getByText('More commerce tools', { exact: true }).click();
    await expectHidden(page.getByRole('link', { name: 'Purchase orders', exact: true }), 'secondary navigation collapses');
    await page.getByText('More commerce tools', { exact: true }).click();
    await expectVisible(page.getByRole('link', { name: 'Purchase orders', exact: true }), 'secondary navigation expands');
    snapshot = { checkedAt, counts: {}, rows: [] };
    await page.getByRole('link', { name: 'Needs attention', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'All queues are clear', exact: true }), 'all work clear snapshot');
    return 'Work-area triage, exact counts, oldest-first previews, failed refresh recovery, mobile navigation and protected case links passed.';
  } finally { await page.close(); }
}
