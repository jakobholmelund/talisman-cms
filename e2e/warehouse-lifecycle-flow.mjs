// Inspection UI recovery, real atomic stocktakes and the shipped customer component.
export async function warehouseLifecycleFlow(ctx, { fail, expectVisible, expectHidden, expectValue, waitUntil }) {
  const page=await ctx.admin.context.newPage(), origin=ctx.options.baseUrl;
  page.removeAllListeners('dialog'); page.on('dialog', d=>d.dismiss().catch(()=>{}));
  const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  const capture=async name=>{if(ctx.options.artifacts)await page.screenshot({path:`${ctx.options.artifacts}/${name}.png`,fullPage:true,animations:'disabled'});};
  const post=async(action,data)=>{const response=await page.request.post('/admin/api/ecommerce/operations',{headers:{Origin:origin},data:{action,data}});if(!response.ok())fail(`${action} failed: ${response.status()} ${await response.text()}`);return response.json();};
  const orderId='ord_inspection_fixture', decisions=[],inspectionWrites=[];let stale=true,lost=true;
  const order={id:orderId,paymentProvider:'stripe',status:'paid',fulfillmentStatus:'fulfilled',customerEmail:'inspection@example.test',currency:'usd',createdAt:'2026-01-01T00:00:00Z',shippingAddress:null,canShip:false,items:[{productId:'fixture',quantity:2,lineTotal:2000,productName:'Inspection fixture',variantLabel:null,sku:'INSPECT'}],amounts:[],activity:[],fulfillmentEvents:[],shipments:[]};
  try {
    const actualId=process.env.TALISMAN_E2E_WAREHOUSE_ORDER_ID;
    if(actualId) {
      const warehouse=await post('warehouseRead',{orderId:actualId});
      if(warehouse.lines[0].remaining>0){const r=await page.request.post('/admin/api/ecommerce/fulfillment',{headers:{Origin:origin},data:{action:'ship',orderId:actualId,requestKey:crypto.randomUUID(),note:'Disposable full parcel physically shipped',items:[{lineIndex:0,quantity:warehouse.lines[0].remaining}]}});if(!r.ok())fail('actual parcel setup failed');}
      const receipt=await post('receiveReturn',{orderId:actualId,requestKey:crypto.randomUUID(),reason:'Two returned units awaiting inspection',items:[{lineIndex:0,quantity:2,condition:'inspection',restock:false}]});
      const request={orderId:actualId,receiptId:receipt.result.receiptId,requestKey:crypto.randomUUID(),reason:'One received unit approved after inspection',items:[{lineIndex:0,quantity:1,disposition:'sellable',restock:true}]};
      const decision=await post('inspectReturn',request), replay=await post('inspectReturn',request);
      if(!replay.result.duplicate||decision.result.inspectionId!==replay.result.inspectionId)fail('actual inspection replay duplicated restoration');
      await post('inspectReturn',{...request,requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:1,disposition:'damaged',restock:false}]});
      const excess=await page.request.post('/admin/api/ecommerce/operations',{headers:{Origin:origin},data:{action:'inspectReturn',data:{...request,requestKey:crypto.randomUUID()}}});if(excess.status()!==409)fail('actual inspection exceeded received goods');
    }
    await page.route('**/api/ecommerce/reconcile',r=>json(r,{tax:[],storeMode:'test',parkedCount:0,parked:[]}));
    await page.route('**/api/ecommerce/orders-admin',r=>json(r,{orders:{}}));
    await page.route('**/api/ecommerce/fulfillment',r=>json(r,{view:'awaiting',pageSize:50,awaitingCount:0,nextCursor:null,orders:[order]}));
    await page.route('**/api/ecommerce/operations',async route=>{
      const body=route.request().postDataJSON();
      if(!body)return route.continue();
      if(body.action==='warehouseRead') return json(route,{orderId,status:'paid',fulfillmentStatus:'fulfilled',canReceive:true,shippingAddress:null,lines:[{lineIndex:0,quantity:2,name:'Inspection fixture',sku:'INSPECT',shipped:2,remaining:0,received:2,returnable:0,restockMapped:true}],unrecorded:[],parcels:[],returns:[{id:'intake-inspection',orderId,items:[{lineIndex:0,quantity:2,condition:'inspection',restock:false}],actor:'receiver',actorName:'Alex',reason:'Goods received for inspection',createdAt:'2026-01-01T00:00:00Z',stock:[],inspectionPending:[{lineIndex:0,quantity:2-decisions.reduce((n,d)=>n+d.items[0].quantity,0)}],inspections:decisions}]});
      if(body.action!=='inspectReturn')return route.continue();inspectionWrites.push(body.data);
      if(stale){stale=false;return json(route,{error:'Inspection quantities changed. Reload the order.'},409);}
      let previous=decisions.find(d=>d.key===body.data.requestKey);
      if(!previous){previous={...body.data,key:body.data.requestKey,id:'inspection-'+decisions.length,actor:'inspector',actorName:'Morgan',createdAt:'2026-01-02T00:00:00Z',stock:body.data.items[0].restock?[{quantity:1}]:[]};decisions.push(previous);}
      if(lost){lost=false;return json(route,{result:null});}
      return json(route,{result:{inspectionId:previous.id,orderId,restocked:previous.stock}});
    });
    await page.goto('/admin/extensions/commerce-orders');await page.getByRole('region',{name:`Order ${orderId}`,exact:true}).locator('.ecom-admin__order-summary').click();const warehouse=page.getByRole('region',{name:`Warehouse ${orderId}`,exact:true});
    await warehouse.getByText('Inspect received goods · 2 pending',{exact:true}).click();const form=warehouse.getByRole('form',{name:'Inspect return intake-inspection',exact:true});
    await form.getByLabel('Units inspected — Inspection fixture',{exact:true}).fill('1');await form.getByLabel('Inspection result — Inspection fixture',{exact:true}).selectOption('sellable');await form.getByRole('checkbox',{name:'Add approved units to available stock',exact:true}).check();
    await form.getByLabel('Reason for inspection decision',{exact:true}).fill('One unit physically inspected and approved');await form.getByRole('button',{name:'Record inspection decision',exact:true}).click();
    await expectVisible(warehouse.getByRole('alert').filter({hasText:'Inspection quantities changed'}),'inspection stale refusal');await expectValue(form.getByLabel('Reason for inspection decision',{exact:true}),'One unit physically inspected and approved','inspection refusal keeps draft');
    await warehouse.getByRole('button',{name:'Refresh quantities',exact:true}).click();await form.getByRole('button',{name:'Record inspection decision',exact:true}).click();
    await expectVisible(warehouse.getByRole('button',{name:'Recover same request',exact:true}),'inspection ambiguous response');if(!await form.getByLabel('Reason for inspection decision',{exact:true}).isDisabled())fail('unconfirmed inspection was editable');
    await warehouse.getByRole('button',{name:'Recover same request',exact:true}).click();await expectVisible(warehouse.getByRole('status').filter({hasText:'Inspection decision recorded'}),'inspection same receipt recovered');
    if(decisions.length!==1||inspectionWrites[1].requestKey!==inspectionWrites[2].requestKey)fail('inspection retry duplicated decision');
    await warehouse.getByText('Inspect received goods · 1 pending',{exact:true}).click();
    await form.getByLabel('Units inspected — Inspection fixture',{exact:true}).fill('1');await form.getByLabel('Inspection result — Inspection fixture',{exact:true}).selectOption('damaged');
    if(!await form.getByRole('checkbox',{name:'Add approved units to available stock',exact:true}).isDisabled())fail('damaged inspection allowed restock');
    await form.getByLabel('Reason for inspection decision',{exact:true}).fill('Remaining damaged unit excluded from available stock');await form.getByRole('button',{name:'Record inspection decision',exact:true}).click();
    await waitUntil('inspection resolved',async()=>decisions.length===2);await expectHidden(warehouse.getByText(/Inspect received goods/),'resolved inspection form');await capture('commerce-return-inspections');
    // Every stock fixture starts at zero, then uses the same audited receipt API as staff.
    const locations=[];
    for(const [index,n] of [3,5].entries()) {
      const response=await page.request.post('/admin/api/collections/_ecommerce_components/entries',{headers:{Origin:origin},data:{data:{sku:`COUNT-${ctx.runId}-${index}`,name:`Stocktake fixture ${ctx.runId} ${index}`,quantity:0}}});if(!response.ok())fail('stocktake fixture creation failed');const row=await response.json();
      await post('stockMovement',{requestKey:crypto.randomUUID(),targetType:'component',targetId:row.id,kind:'receipt',delta:n,expectedQuantity:0,expectedUpdatedAt:row.updatedAt,reason:'Supplier units checked for physical count fixture'});locations.push(row.id);
    }
    await page.getByRole('link',{name:'Stock overview',exact:true}).click();await page.getByText('Count & reconcile inventory',{exact:true}).click();const panel=page.getByRole('region',{name:'Stocktakes',exact:true});
    await panel.getByLabel('Find stock to count',{exact:true}).fill(`Stocktake fixture ${ctx.runId}`);await panel.getByRole('button',{name:'Find stock to count',exact:true}).click();await panel.getByText('Available stock records',{exact:true}).click();
    await panel.getByRole('button',{name:`Add to count · Stocktake fixture ${ctx.runId} 0`,exact:true}).click();await panel.getByRole('button',{name:`Add to count · Stocktake fixture ${ctx.runId} 1`,exact:true}).click();
    const countForm=panel.getByRole('form',{name:'Stocktake count',exact:true});const a=countForm.getByLabel(`Counted units — Stocktake fixture ${ctx.runId} 0`,{exact:true}),b=countForm.getByLabel(`Counted units — Stocktake fixture ${ctx.runId} 1`,{exact:true});
    await a.fill('2');await b.fill('7');
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const win=open(...args);if(win)win.print=()=>{};return win;};});
    const sheetPromise=page.waitForEvent('popup');await countForm.getByRole('button',{name:'Print count sheet',exact:true}).click();const sheet=await sheetPromise;
    await expectVisible(sheet.getByRole('heading',{name:'Available stock count sheet',exact:true}),'printable count sheet');await expectVisible(sheet.getByText(/Exclude units held/),'count sheet excludes held units');await sheet.close();await countForm.getByLabel('Reason for stocktake',{exact:true}).fill('Warehouse count excludes reserved and damaged units');await countForm.getByRole('checkbox').check();
    const fresh=await post('stocktakeRead',{targets:[{targetType:'component',targetId:locations[1]}]});const current=fresh.rows[0];await post('stockMovement',{requestKey:crypto.randomUUID(),targetType:'component',targetId:current.id,kind:'receipt',delta:1,expectedQuantity:current.quantity,expectedUpdatedAt:current.updatedAt,reason:'Competing checked delivery received during count'});
    await countForm.getByRole('button',{name:'Apply stocktake',exact:true}).click();await expectVisible(panel.getByRole('alert').filter({hasText:'No counts were applied'}),'atomic stale count refusal');
    await expectValue(a,'2','stale count retains first counted quantity');const unchanged=await post('stocktakeRead',{targets:[{targetType:'component',targetId:locations[0]}]});if(unchanged.rows[0].quantity!==3)fail('stale stocktake partially applied');
    await countForm.getByRole('button',{name:'Reload all expected counts',exact:true}).click();await waitUntil('stocktake reviewed fresh versions',async()=>!await countForm.getByRole('checkbox').isDisabled());await countForm.getByRole('checkbox').check();
    await page.setViewportSize({width:390,height:844});await expectHidden(page.getByRole('button',{name:'Close navigation menu',exact:true}),'stocktake mobile menu closes');await countForm.scrollIntoViewIfNeeded();await capture('commerce-stocktake-discrepancies-mobile');if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1))fail('count draft overflows mobile');await page.setViewportSize({width:1280,height:900});
    const counts=[];let dropped=false;await page.route('**/api/ecommerce/operations',async route=>{const body=route.request().postDataJSON();if(body?.action!=='stocktake')return route.fallback();counts.push(body.data);const response=await route.fetch();if(!dropped&&response.ok()){dropped=true;return json(route,{result:null});}return route.fulfill({response});});
    await countForm.getByRole('button',{name:'Apply stocktake',exact:true}).click();await expectVisible(panel.getByRole('button',{name:'Recover same request',exact:true}),'stocktake lost response recovery');if(!await a.isDisabled())fail('unconfirmed stocktake was editable');await panel.getByRole('button',{name:'Recover same request',exact:true}).click();
    await expectVisible(panel.getByRole('status').filter({hasText:'Stocktake recorded'}),'stocktake receipt recovered');if(counts.length!==2||counts[0].requestKey!==counts[1].requestKey)fail('stocktake replay changed receipt key');
    const final=await post('stocktakeRead',{targets:locations.map(targetId=>({targetType:'component',targetId}))});if(final.rows.find(r=>r.id===locations[0]).quantity!==2||final.rows.find(r=>r.id===locations[1]).quantity!==7)fail('count discrepancies were not applied exactly once');
    await capture('commerce-stocktakes');await page.setViewportSize({width:390,height:844});await expectHidden(page.getByRole('button',{name:'Close navigation menu',exact:true}),'stocktake mobile menu closes');await panel.getByRole('heading',{name:'Count available stock',exact:true}).scrollIntoViewIfNeeded();await capture('commerce-stocktakes-mobile');if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1))fail('stocktake overflows mobile');
    // The actual shipped component uses the owner credentials and excludes staff reasons.
    if(actualId) {
      await ctx.admin.context.addCookies([{name:`talisman-order-${actualId}`,value:'warehouse-guest-test',url:origin}]);
      const response=await page.request.get(`/api/ecommerce/order?order=${actualId}`);if(!response.ok())fail('actual shopper order tracking refused owner cookie');const data=await response.json();
      if(data.tracking.lines[0].remaining!==0||!data.tracking.returns.length)fail('actual shopper parcel/return data missing');const serialized=JSON.stringify(data.tracking);if(/actor|reason|stockTargets|fingerprint|reservation/.test(serialized))fail('shopper projection exposed warehouse internals');
      const anon=await ctx.browser.newContext();const denied=await anon.request.get(`${origin}/api/ecommerce/order?order=${actualId}`);if(denied.status()!==404)fail('anonymous shopper could inspect order');await anon.close();
      await page.goto(`/checkout/success?order=${actualId}`);const tracking=page.getByRole('region',{name:'Parcels and returns',exact:true});await expectVisible(tracking.getByText('Parcel details are up to date.',{exact:true}),'shopper component loaded authenticated parcel data');
      await capture('customer-order-tracking-mobile');
      let failRefresh=true;await page.route('**/api/ecommerce/order?*',route=>failRefresh?json(route,{error:'Unavailable'},503):route.continue());await tracking.getByRole('button',{name:'Refresh parcel details',exact:true}).click();await expectVisible(tracking.getByText(/Displayed details may be out of date/),'tracking failed refresh retains snapshot');failRefresh=false;await tracking.getByRole('button',{name:'Refresh parcel details',exact:true}).click();await expectVisible(tracking.getByText('Parcel details are up to date.',{exact:true}),'tracking refresh recovered');
    }
    return 'inspection decisions keep drafts, recover receipts and exclude damaged goods; real stocktakes rollback stale counts and recover one atomic receipt; mobile layout'+(actualId?'; actual D1 inspection guards and owner-only customer tracking component':'');
  } catch(error) {await capture('warehouse-lifecycle-failure');throw error;} finally {await page.close();}
}
