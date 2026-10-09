// Actual local stock writes plus controlled historical-order intake responses. No provider calls.
export async function warehouseFlow(ctx, { fail, expectVisible, expectHidden, expectValue, waitUntil }) {
  const page=await ctx.admin.context.newPage(), origin=ctx.options.baseUrl;
  page.removeAllListeners('dialog'); page.on('dialog',d=>d.dismiss());
  const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  const orderId='ord_warehouse_fixture';
  const order={id:orderId,paymentProvider:'stripe',status:'paid',fulfillmentStatus:'fulfilled',customerEmail:'warehouse@example.test',currency:'usd',createdAt:'2026-01-01T00:00:00Z',shippingAddress:null,canShip:false,
    items:[{productId:'fixture',variantId:null,quantity:4,lineTotal:4000,productName:'Return fixture',variantLabel:null,sku:'RETURN'}],amounts:[],activity:[],fulfillmentEvents:[],shipments:[{id:'parcel-fixture',createdAt:'2026-01-01T00:00:00Z',adminActor:'staff',note:'Four units physically shipped',carrier:'Fixture carrier',trackingNumber:'TRACK',completesOrder:true,recorded:{carrier:'Fixture carrier',trackingNumber:'TRACK'},corrections:[]}]};
  const receipts=[],writes=[],keys=new Map();let stale=true,lose=true,received=0,componentId;
  const capture=async name=>{if(ctx.options.artifacts){const {join}=await import('node:path');await page.screenshot({path:join(ctx.options.artifacts,`${name}.png`),fullPage:true});}};
  try {
    // An optional disposable D1 fixture exercises the actual Worker/Drizzle/JSON-trigger path.
    const actualId=process.env.TALISMAN_E2E_WAREHOUSE_ORDER_ID;
    if(actualId){
      const post=async(path,body)=>{const response=await page.request.post(`/admin/api/ecommerce/${path}`,{headers:{Origin:origin},data:body});if(!response.ok())fail(`Actual warehouse action failed: ${response.status()} ${await response.text()}`);return response.json();};
      const parcel={action:'ship',orderId:actualId,requestKey:crypto.randomUUID(),note:'Disposable local parcel fixture',items:[{lineIndex:0,quantity:1}]};
      const first=await post('fulfillment',parcel),duplicate=await post('fulfillment',parcel);
      if(first.result.fulfillmentId!==duplicate.result.fulfillmentId||!duplicate.result.duplicate)fail('Actual D1 parcel retry duplicated its receipt');
      await post('fulfillment',{...parcel,requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:3}]});
      const receipt={action:'receiveReturn',data:{orderId:actualId,requestKey:crypto.randomUUID(),reason:'Disposable sellable goods received',items:[{lineIndex:0,quantity:1,condition:'sellable',restock:true}]}};
      const returned=await post('operations',receipt),recovered=await post('operations',receipt);
      if(returned.result.receiptId!==recovered.result.receiptId||returned.result.restocked[0].quantity!==1)fail('Actual D1 return receipt was not recovered');
      await post('operations',{action:'receiveReturn',data:{...receipt.data,requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:1,condition:'damaged',restock:false}]}});
      const warehouse=await post('operations',{action:'warehouseRead',data:{orderId:actualId}});
      if(warehouse.lines[0].remaining!==0||warehouse.lines[0].received!==2||warehouse.returns.length!==2)fail('Actual D1 parcel/intake quantities drifted');
      const stocks=await page.request.get('/admin/api/ecommerce/operations?view=stockLocations&search=Disposable%20warehouse%20goods');
      if(!stocks.ok()||(await stocks.json()).rows[0].quantity!==17)fail('Actual D1 return restored the wrong stock quantity');
      const excess=await page.request.post('/admin/api/ecommerce/operations',{headers:{Origin:origin},data:{action:'receiveReturn',data:{...receipt.data,requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:3,condition:'sellable',restock:true}]}}});
      if(excess.status()!==409)fail('Actual D1 intake accepted more goods than shipped');
    }
    await page.route('**/api/ecommerce/reconcile',r=>json(r,{tax:[],storeMode:'test',parkedCount:0,parked:[]}));
    await page.route('**/api/ecommerce/orders-admin',r=>json(r,{orders:{}}));
    await page.route('**/api/ecommerce/fulfillment',r=>json(r,{view:'awaiting',pageSize:50,awaitingCount:0,nextCursor:null,orders:[order]}));
    await page.route('**/api/ecommerce/operations',async route=>{
      const body=route.request().postDataJSON();
      if(body.action==='warehouseRead') return json(route,{orderId,status:'paid',fulfillmentStatus:'fulfilled',canReceive:true,shippingAddress:{name:'Fixture buyer',line1:'1 Test Lane',city:'Test City',postalCode:'12345',country:'US'},
        lines:[{lineIndex:0,quantity:4,name:'Return fixture',sku:'RETURN',shipped:4,remaining:0,received,returnable:4-received,restockMapped:true}],unrecorded:[],parcels:[{id:'contents',fulfillmentId:'parcel-fixture',items:[{lineIndex:0,quantity:4}],actor:'staff',actorName:'Alex',reason:'Four units physically shipped',createdAt:'2026-01-01T00:00:00Z'}],returns:receipts});
      if(body.action!=='receiveReturn') return route.continue();
      writes.push(body.data);
      if(stale){stale=false;return json(route,{error:'Return quantities changed. Refresh the order.'},409);}
      let receipt=keys.get(body.data.requestKey);
      if(!receipt){receipt={id:'return-'+keys.size,receiptId:'return-'+keys.size,...body.data,actor:'staff',actorName:'Alex',createdAt:'2026-01-02T00:00:00Z',stock:body.data.items[0].restock?[{quantity:body.data.items[0].quantity}]:[]};keys.set(body.data.requestKey,receipt);receipts.push(receipt);received+=body.data.items[0].quantity;}
      if(lose){lose=false;return json(route,{result:null});}
      return json(route,{result:{receiptId:receipt.id,orderId,restocked:receipt.stock}});
    });
    await page.goto('/admin/extensions/commerce-orders');
    const warehouse=page.getByRole('region',{name:`Warehouse ${orderId}`,exact:true});
    await expectVisible(warehouse.getByRole('button',{name:'Print packing slip',exact:true}),'parcel packing slip');
    // A blank popup with print stubbed lets the test inspect the exact printable contents.
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const win=open(...args);if(win)win.print=()=>{};return win;};});
    const popupPromise=page.waitForEvent('popup');await warehouse.getByRole('button',{name:'Print packing slip',exact:true}).click();const popup=await popupPromise;
    await expectVisible(popup.getByText('4 × Return fixture · SKU RETURN',{exact:true}),'exact parcel packing quantity');
    if(await popup.getByText(/4000|40\.00/).count())fail('packing slip exposed order prices');await popup.close();
    await warehouse.getByText('Receive returned goods',{exact:true}).click();
    const form=warehouse.getByRole('form',{name:'Return intake',exact:true});
    await form.getByLabel('Received quantity — Return fixture',{exact:true}).fill('1');
    await form.getByLabel('Condition — Return fixture',{exact:true}).selectOption('damaged');
    await form.getByLabel('Reason for the return',{exact:true}).fill('Damaged unit physically received');
    await form.getByRole('button',{name:'Record return intake',exact:true}).click();
    await expectVisible(warehouse.getByRole('alert').filter({hasText:'Return quantities changed'}),'stale return conflict');
    await expectValue(form.getByLabel('Reason for the return',{exact:true}),'Damaged unit physically received','return conflict keeps draft');
    if(!await form.getByRole('button',{name:'Record return intake',exact:true}).isDisabled())fail('stale return remained writable');
    await warehouse.getByRole('button',{name:'Refresh quantities',exact:true}).click();
    await form.getByRole('button',{name:'Record return intake',exact:true}).click();
    await expectVisible(warehouse.getByRole('alert').filter({hasText:'response was incomplete'}),'lost return receipt');
    if(!await form.getByLabel('Reason for the return',{exact:true}).isDisabled())fail('unconfirmed return draft was editable');
    await warehouse.getByRole('button',{name:'Recover same request',exact:true}).click();
    await expectVisible(warehouse.getByRole('status').filter({hasText:'Return intake recorded'}),'recovered return receipt');
    if(writes[1].requestKey!==writes[2].requestKey||receipts.length!==1||received!==1)fail('return receipt recovery double-counted goods');
    await form.getByLabel('Received quantity — Return fixture',{exact:true}).fill('1');
    await form.getByLabel('Condition — Return fixture',{exact:true}).selectOption('sellable');
    await form.getByRole('checkbox',{name:'Restock received sellable units',exact:true}).check();
    await form.getByLabel('Reason for the return',{exact:true}).fill('Sellable unit physically received');
    await form.getByRole('button',{name:'Record return intake',exact:true}).click();
    await waitUntil('second intake recorded',async()=>receipts.length===2);
    await expectVisible(warehouse.getByText(/1 × Return fixture · damaged · Kept out of stock/),'damaged unit stays out of stock');
    await expectVisible(warehouse.getByText(/1 × Return fixture · sellable · Restocked/),'sellable unit restocked');
    await capture('commerce-return-intake');
    // Use an actual local stock record and actual worker writes for receipts and corrections.
    const fixture=await page.request.post('/admin/api/collections/_ecommerce_components/entries',{headers:{Origin:origin},data:{data:{sku:`WAREHOUSE-${ctx.runId}`,name:'Warehouse shared-part fixture',quantity:0}}});
    if(!fixture.ok())fail('stock fixture creation failed');componentId=(await fixture.json()).id;
    const initial=(await (await page.request.get(`/admin/api/collections/_ecommerce_components/entries/${componentId}`)).json());
    const filled=await page.request.post('/admin/api/ecommerce/operations',{headers:{Origin:origin},data:{action:'stockMovement',data:{requestKey:crypto.randomUUID(),targetType:'component',targetId:componentId,kind:'receipt',delta:3,expectedQuantity:0,expectedUpdatedAt:initial.updatedAt,reason:'Initial physical available stock received'}}});
    if(!filled.ok())fail('audited stock fixture receipt failed');
    await warehouse.getByRole('button',{name:'Discard warehouse draft',exact:true}).count().then(n=>{if(n)fail('confirmed return left an unsaved draft');});
    await page.getByRole('link',{name:'Stock overview',exact:true}).click();
    const panel=page.getByRole('region',{name:'Stock movements',exact:true});
    await panel.getByLabel('Find a stock record',{exact:true}).fill('Warehouse shared-part fixture');await panel.getByRole('button',{name:'Find stock records',exact:true}).click();
    await panel.getByLabel('Stock record',{exact:true}).selectOption(`component:${componentId}`);
    const change=panel.getByRole('form',{name:'Stock change',exact:true});
    let dropped=false;const movements=[];
    await page.route('**/api/ecommerce/operations',async route=>{
      const body=route.request().postDataJSON();if(body.action!=='stockMovement')return route.fallback();movements.push(body.data);
      const response=await route.fetch();if(!dropped&&response.ok()){dropped=true;return json(route,{result:null});}return route.fulfill({response});
    });
    await change.getByLabel('Units received',{exact:true}).fill('4');await change.getByLabel('Reason for stock change',{exact:true}).fill('Supplier delivery checked and received');
    await change.getByRole('button',{name:'Record stock change',exact:true}).click();
    await expectVisible(panel.getByRole('button',{name:'Recover same request',exact:true}),'stock receipt lost response');
    await panel.getByRole('button',{name:'Recover same request',exact:true}).click();
    await expectVisible(change.getByText('7',{exact:true}),'incoming stock applied once');
    if(movements[0].requestKey!==movements[1].requestKey)fail('stock receipt retry changed key');
    await change.getByLabel('Change type',{exact:true}).selectOption('correction');await change.getByLabel('Quantity change (positive or negative)',{exact:true}).fill('-2');await change.getByLabel('Reason for stock change',{exact:true}).fill('Damaged parts removed after inspection');
    const entry=await page.request.get(`/admin/api/collections/_ecommerce_components/entries/${componentId}`);const loaded=await entry.json();
    const update=await page.request.post('/admin/api/ecommerce/operations',{headers:{Origin:origin},data:{action:'stockMovement',data:{requestKey:crypto.randomUUID(),targetType:'component',targetId:componentId,kind:'receipt',delta:2,expectedQuantity:7,expectedUpdatedAt:loaded.updatedAt,reason:'Competing supplier delivery received'}}});
    if(!update.ok())fail(`competing stock update failed: ${update.status()} ${await update.text()}`);
    await change.getByRole('button',{name:'Record stock change',exact:true}).click();
    await expectVisible(panel.getByRole('alert').filter({hasText:'Stock changed'}),'real stale stock conflict');
    await expectValue(change.getByLabel('Reason for stock change',{exact:true}),'Damaged parts removed after inspection','stock conflict retains reason');
    if(!await change.getByRole('button',{name:'Record stock change',exact:true}).isDisabled())fail('stale stock change remained writable');
    await panel.getByRole('button',{name:'Refresh',exact:true}).first().click();
    await expectVisible(change.getByText('9',{exact:true}),'fresh stock quantity');
    await change.getByRole('button',{name:'Record stock change',exact:true}).click();
    await expectVisible(change.getByText('7',{exact:true}),'stock correction applied');
    await expectVisible(panel.getByRole('region',{name:'Stock movement history',exact:true}).getByText(/Damaged parts removed after inspection/),'correction reason history');
    await capture('commerce-stock-movements');await page.setViewportSize({width:390,height:844});
    await expectHidden(page.getByRole('button',{name:'Close navigation menu',exact:true}),'mobile menu closes');
    await panel.getByRole('heading',{name:'Incoming stock, corrections and history',exact:true}).scrollIntoViewIfNeeded();
    await capture('commerce-stock-movements-mobile');
    await panel.getByRole('heading',{name:/Movement history/}).scrollIntoViewIfNeeded();
    await capture('commerce-stock-history-mobile');
    if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))fail('stock movement page overflows mobile');
    return (actualId?'actual local D1 parcel/intake receipts and caps; ':'')+'exact packing slip; return conditions, conflict drafts and lost receipts; actual local stock receipt/correction, concurrency and immutable staff history; mobile layout';
  } catch (cause) { await capture('commerce-warehouse-active-failure'); console.error('Warehouse failure at',page.url(), await page.getByRole('region',{name:'Stock movements',exact:true}).innerText().catch(()=>'')); if(componentId) console.error('Stock history response', await (await page.request.get(`/admin/api/ecommerce/operations?view=stockHistory&targetType=component&targetId=${componentId}`)).text()); throw cause; } finally {await page.close();}
}
