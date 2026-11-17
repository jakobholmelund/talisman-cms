// Orders UI regressions use controlled API responses: provider calls and live orders are never involved.
// Fulfillment's database invariants and replay handling are exercised by the plugin's service tests.
export async function ordersFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }) {
  const page = await ctx.admin.context.newPage();
  const endpoint = '**/api/ecommerce/fulfillment';
  const writes = [];
  const reads = [];
  const orders = Array.from({ length: 51 }, (_, index) => ({
    id: `ord_browser_${String(index).padStart(3, '0')}`, paymentProvider: 'stripe', status: 'paid',
    fulfillmentStatus: 'unfulfilled', customerEmail: `shopper${index}@example.com`, currency: 'usd',
    createdAt: '2026-01-01T12:00:00.000Z', shippingAddress: null, canShip: true,
    items: [{ productId: 'fixture', variantId: null, quantity: 4, lineTotal: 1200, productName: 'Browser fixture', variantLabel: null, sku: 'FIXTURE' }],
    activity: [{ id: 'activity-'+index, kind: 'restock', createdAt: '2026-01-02T12:00:00Z', detail: 'Returned one parcel', actor: 'staff', actorName: 'Alex', amountCents: null, email: null }],
    amounts: [{ key: 'total', label: 'Total', cents: 1200 }], shipments: [], parcels: [], fulfillmentEvents: [],
  }));
  let failRead = true;
  let failWrite = false;
  let failRefresh = false;
  let pendingRead;
  let pendingWrite;
  let holdNextWrite = false;
  let acceptDialog = false;
  let confirmations = 0;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const card = id => page.getByRole('region', { name: `Order ${id}`, exact: true });
  const order = orders[0];
  const form = () => card(order.id).locator('form').filter({ has: page.getByRole('heading', { name: 'Record shipment', exact: true }) });
  const settle = () => expectHidden(page.getByRole('status').filter({ hasText: 'Loading orders' }), 'orders load');
  const search = async value => {
    await page.getByRole('searchbox', { name: 'Find an order', exact: true }).fill(value);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  };
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => { confirmations++; await (acceptDialog ? dialog.accept() : dialog.dismiss()); });
  try {
    // Check the actual local list contract before substituting response fixtures.
    const actual = await page.request.post('/admin/api/ecommerce/fulfillment', {
      headers: { Origin: ctx.options.baseUrl }, data: { action: 'list', view: 'awaiting', limit: 50 },
    });
    if (!actual.ok() || !actual.headers()['cache-control']?.includes('no-store')) fail('real orders list contract failed');
    const real = await actual.json();
    if (!Array.isArray(real.orders) || real.orders.some(row => row.paymentProvider === 'admin_test')) fail('orders list included admin test orders');
    await page.route('**/api/ecommerce/reconcile', route => json(route, { tax: [], storeMode: 'test', parkedCount: 0, parked: [] }));
    await page.route('**/api/ecommerce/orders-admin', route => json(route, { orders: {} }));
    await page.route('**/api/ecommerce/operations', route => {
      const body = route.request().postDataJSON(), item = orders.find(row => row.id === body.data?.orderId);
      if (body.action !== 'warehouseRead' || !item) return route.continue();
      const shipped = item.parcels.reduce((n, p) => n + p.items[0].quantity, 0);
      return json(route, { orderId: item.id, status: item.status, fulfillmentStatus: item.fulfillmentStatus,
        lines: [{ lineIndex: 0, quantity: 4, name: 'Browser fixture', sku: 'FIXTURE', shipped, received: 0, remaining: 4 - shipped, returnable: shipped, restockMapped: true }],
        unrecorded: [], parcels: item.parcels, returns: [], shippingAddress: null, canReceive: true });
    });
    await page.route(endpoint, async route => {
      const request = route.request();
      const body = request.postDataJSON();
      if (request.method() !== 'POST' || new URL(request.url()).search) fail('orders search leaked into the URL');
      if (body.action === 'list') {
        reads.push(body);
        if (body.query === 'slow@example.com') { pendingRead = route; return; }
        if (failRead || failRefresh) { failRead = false; failRefresh = false; return json(route, { error: 'Orders temporarily unavailable' }, 503); }
        const matching = orders.filter(row => (body.view === 'recent' || row.fulfillmentStatus !== 'fulfilled')
          && (!body.query || [row.id, row.customerEmail].includes(body.query)));
        const offset = body.cursor ? 50 : 0;
        return json(route, { view: body.view, pageSize: 50, awaitingCount: orders.filter(row => row.canShip).length,
          nextCursor: matching.length > offset + 50 ? 'next-page' : null, orders: matching.slice(offset, offset + 50) });
      }
      writes.push(body);
      if (holdNextWrite) { holdNextWrite = false; pendingWrite = route; return; }
      if (failWrite) { failWrite = false; return json(route, { error: 'Shipment confirmation unavailable' }, 503); }
      if (body.action === 'ship') {
        const shipped = order.parcels.reduce((n, p) => n + p.items[0].quantity, 0) + body.items[0].quantity;
        body.completesOrder = shipped === 4;
        order.shipments.push({ id: `shipment_${order.shipments.length}`, createdAt: order.createdAt, adminActor: 'browser-admin',
          carrier: body.carrier, trackingNumber: body.trackingNumber, note: body.note, completesOrder: body.completesOrder,
          recorded: { carrier: body.carrier, trackingNumber: body.trackingNumber }, corrections: [] });
        order.parcels.push({ id: 'parcel_'+order.parcels.length, fulfillmentId: order.shipments.at(-1).id, items: body.items, actor: 'browser-admin', actorName: 'Alex', reason: body.note, createdAt: order.createdAt });
        order.canShip = !body.completesOrder;
        order.fulfillmentStatus = body.completesOrder ? 'fulfilled' : 'partially_fulfilled';
      } else if (body.action === 'correct') {
        const shipment = order.shipments.find(row => row.id === body.fulfillmentId);
        shipment.carrier = body.carrier; shipment.trackingNumber = body.trackingNumber;
        shipment.corrections.push({ id: 'correction_1', createdAt: order.createdAt, adminActor: 'browser-admin', ...body });
      }
      return json(route, { result: { fulfillmentId: order.shipments.at(-1)?.id || 'correction' } });
    });
    await page.goto('/admin/extensions/commerce-orders');
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Orders temporarily unavailable' }), 'initial orders failure');
    await page.getByRole('button', { name: 'Retry loading orders', exact: true }).click();
    await expectVisible(card(order.id), 'recovered orders'); await settle();
    await expectNoAlert(page, 'recovered orders');
    if (await page.getByRole('heading', { name: 'Record shipment', exact: true }).count()) fail('unopened rows mounted their warehouse forms');
    await card(order.id).locator('.ecom-admin__order-summary').click();
    await card(order.id).getByText('Order activity', { exact: true }).click();
    await expectVisible(card(order.id).getByText('Alex', { exact: true }), 'activity staff name');
    await expectVisible(card(order.id).getByText(/Returned one parcel/), 'activity restock reason');
    if (await page.getByRole('region', { name: /^Order ord_browser_/ }).count() !== 50) fail('orders first page was not bounded');
    await form().getByLabel('Shipment note', { exact: true }).fill('Keep this draft parcel');
    await card(order.id).locator('.ecom-admin__order-summary').click();
    await card(order.id).locator('.ecom-admin__order-summary').click();
    await expectValue(form().getByLabel('Shipment note', { exact: true }), 'Keep this draft parcel', 'collapsing an order preserves its parcel draft');
    failRead = true;
    await page.getByRole('button', { name: 'Load 50 more', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Orders temporarily unavailable' }), 'failed orders next page');
    await expectValue(form().getByLabel('Shipment note', { exact: true }), 'Keep this draft parcel', 'draft after failed pagination');
    if (await form().getByRole('button', { name: 'Record shipment', exact: true }).isDisabled() !== true) fail('failed reads allowed a shipment');
    await page.getByRole('button', { name: 'Retry loading orders', exact: true }).click();
    await expectVisible(card(orders[50].id), 'retried next page'); await settle();
    if (!await page.getByRole('status').filter({ hasText: 'Showing 51 orders' }).evaluate(node => node === document.activeElement)) fail('orders pagination lost focus');
    if (reads.at(-1).cursor !== 'next-page' || await page.getByRole('region', { name: /^Order ord_browser_/ }).count() !== 51) fail('next-page retry lost its cursor or duplicated rows');
    await expectValue(form().getByLabel('Shipment note', { exact: true }), 'Keep this draft parcel', 'draft after successful pagination');
    acceptDialog = true;
    // An older failing search cannot overwrite a newer, successful one.
    await search('slow@example.com');
    await waitUntil('slow order request should be held', async () => Boolean(pendingRead));
    await search(order.customerEmail);
    await expectVisible(card(order.id), 'exact email result'); await settle();
    const obsolete = page.waitForResponse(response => response.request().postData()?.includes('slow@example.com'));
    await json(pendingRead, { error: 'Obsolete search failed' }, 503); pendingRead = null;
    await (await obsolete).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectNoAlert(page, 'superseded search failure');
    if (await page.getByRole('region', { name: /^Order ord_browser_/ }).count() !== 1 || reads.at(-1).query !== order.customerEmail) fail('exact email search was not applied');
    // Failed writes preserve the fields and the request key. An immediate duplicate submit sends once.
    await form().getByLabel('Carrier', { exact: true }).fill('Fixture carrier');
    await form().getByLabel('Tracking number', { exact: true }).fill('FIRST-PARCEL');
    await form().getByLabel('Shipment note', { exact: true }).fill('First parcel dispatched');
    await form().getByRole('spinbutton').fill('1');
    holdNextWrite = true;
    await form().evaluate(node => { node.requestSubmit(); node.requestSubmit(); });
    await waitUntil('shipment write should be held', async () => Boolean(pendingWrite));
    if (writes.length !== 1) fail('duplicate submit sent more than one shipment');
    if (!await form().getByLabel('Shipment note', { exact: true }).isDisabled()) fail('pending write allowed details to change');
    await json(pendingWrite, { error: 'Shipment confirmation unavailable' }, 503); pendingWrite = null;
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Shipment confirmation unavailable' }), 'unconfirmed shipment');
    await expectValue(form().getByLabel('Tracking number', { exact: true }), 'FIRST-PARCEL', 'tracking after failed shipment');
    const readCount = reads.length;
    await card(order.id).getByRole('button', { name: 'Recover same request', exact: true }).click();
    await expectVisible(page.getByRole('status').filter({ hasText: 'Parcel and its item quantities recorded' }), 'retried partial shipment');
    if (writes[0].requestKey !== writes[1].requestKey || !writes[1].requestKey) fail('shipment retry changed its replay key');
    if (reads.length !== readCount + 1) fail('shipment success did not refresh once');
    await expectVisible(card(order.id).getByText('Partial shipment: Fixture carrier · FIRST-PARCEL', { exact: true }), 'partial parcel history');
    await expectValue(form().getByLabel('Shipment note', { exact: true }), '', 'successful shipment cleared its note');
    await card(order.id).getByText('Correct carrier or tracking number', { exact: true }).click();
    const correction = card(order.id).locator('details form').filter({ has: page.getByLabel('Reason for the correction', {exact:true}) });
    await correction.getByLabel('Tracking number', { exact: true }).fill('CORRECTED-PARCEL');
    await correction.getByLabel('Reason for the correction', { exact: true }).fill('Fixed the tracking typo');
    failWrite = true;
    await correction.getByRole('button', { name: 'Record correction', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Shipment confirmation unavailable' }), 'failed correction');
    await expectValue(correction.getByLabel('Reason for the correction', { exact: true }), 'Fixed the tracking typo', 'correction reason after refusal');
    await correction.getByRole('button', { name: 'Record correction', exact: true }).click();
    await expectVisible(card(order.id).getByText('First recorded as Fixture carrier · FIRST-PARCEL', { exact: true }), 'original parcel retained');
    await expectVisible(card(order.id).getByText(/Reason: Fixed the tracking typo/), 'correction audit reason');
    // Quantities complete a split order automatically. A saved parcel remains confirmed when the list refresh fails.
    await form().getByLabel('Shipment note', { exact: true }).fill('Final parcel dispatched');
    await form().getByRole('spinbutton').fill('3');
    const beforeFinal = writes.length;
    failRefresh = true;
    await form().getByRole('button', { name: 'Record shipment', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'Orders temporarily unavailable' }), 'saved shipment with failed refresh');
    await expectVisible(card(order.id).getByRole('status').filter({ hasText: 'Parcel and its item quantities recorded' }), 'saved parcel receipt');
    if (writes.length !== beforeFinal + 1) fail('final parcel was recorded more than once');
    await page.getByRole('button', { name: 'Retry loading orders', exact: true }).click();
    await expectVisible(page.getByRole('heading', { name: 'No matching orders', exact: true }), 'completed order left queue');
    await page.getByRole('group', { name: 'Order views' }).getByRole('button', { name: 'All recent orders', exact: true }).click();
    await expectVisible(card(order.id), 'shipped order in recent view'); await settle();
    await expectVisible(card(order.id).getByText(/Payment: Paid · Fulfillment: Shipped/), 'payment separate from shipping');
    if (await card(order.id).getByRole('button', { name: 'Record shipment', exact: true }).count()) fail('fully shipped order offered another parcel');
    await search('missing@example.com');
    await expectVisible(page.getByRole('heading', { name: 'No matching orders', exact: true }), 'orders search empty state');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expectVisible(card(order.id), 'clear order search');
    return 'real local list contract; controlled reads/writes cover privacy, pagination, stale failures, retry keys, partial/final parcels, corrections and refresh recovery';
  } catch (cause) {
    if (ctx.options.artifacts) {
      const { join } = await import('node:path');
      await page.screenshot({ path: join(ctx.options.artifacts, 'orders-active-failure.png'), fullPage: true });
    }
    throw cause;
  } finally {
    if (pendingRead) await pendingRead.abort().catch(() => {});
    if (pendingWrite) await pendingWrite.abort().catch(() => {});
    await page.close();
  }
}
