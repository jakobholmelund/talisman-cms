import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import axe from 'axe-core';

/** Real email route + local console transport; tokens are read privately from a throwaway Worker log. */
export async function customerHubFlow(ctx,{expectVisible,waitUntil}) {
 const log=process.env.TALISMAN_E2E_EMAIL_LOG;
 if(!log || process.env.TALISMAN_E2E_JOURNEY!=='1'){const e=new Error('Requires isolated commerce-journey and TALISMAN_E2E_EMAIL_LOG for the local console provider.');e.skip=true;throw e;}
 assert.ok(['localhost','127.0.0.1'].includes(new URL(ctx.options.baseUrl).hostname));
 const result=JSON.parse(await readFile('/tmp/talisman-journey-result.json','utf8'));
 const orderId=result.orderId,email=`journey-${ctx.runId}@example.test`,reference=`TAL-${orderId.slice(-12).toUpperCase()}`;
 assert.equal(result.final.status,'refunded');
 const context=await ctx.browser.newContext({baseURL:ctx.options.baseUrl,viewport:{width:1280,height:1000}});
 const other=await ctx.browser.newContext({baseURL:ctx.options.baseUrl,viewport:{width:390,height:844}});
 const page=await context.newPage(), stranger=await other.newPage();
 const scans=[];
 const scan=async(p,name)=>{await p.evaluate(axe.source);const result=await p.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']},resultTypes:['violations','incomplete']}));scans.push({name,violations:result.violations,incomplete:result.incomplete});await writeFile('/tmp/talisman-hub-accessibility.json',JSON.stringify(scans,null,2));assert.deepEqual(result.violations.map(v=>v.id),[],`${name} accessibility`);};
 const capture=async(name)=>ctx.options.artifacts&&page.screenshot({path:`${ctx.options.artifacts}/hub-${name}.png`,fullPage:true});
 const requestLink=async(p,address)=>{
  const before=(await readFile(log,'utf8')).length;
  await p.getByLabel('Email address',{exact:true}).fill(address);await p.getByRole('button',{name:/Email me a sign-in link/}).click();
  await waitUntil('sign-in confirmation',async()=>/Check your inbox/.test(await p.locator('[data-signin-feedback]').innerText()));
  let link;
  await waitUntil('local sign-in email',async()=>{const text=(await readFile(log,'utf8')).slice(before);link=text.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/account\/verify#token=[^\s]+/)?.[0];return Boolean(link);});
  return link;
 };
 try {
  // Start with an emailed order link on a completely fresh device: no guest basket credentials.
  const inaccessible=await page.goto(`/checkout/success?order=${orderId}`);assert.equal(inaccessible.status(),404);
  await page.getByRole('link',{name:'Sign in to view your order',exact:true}).click();
  await scan(page,'sign-in');
  await page.route('**/api/ecommerce/account',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Email sign-in is temporarily unavailable. Please try again.'})}),{times:1});
  await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByRole('button',{name:/Email me a sign-in link/}).click();await waitUntil('retryable email error',async()=>/temporarily unavailable/.test(await page.locator('[data-signin-feedback]').innerText()));
  const link=await requestLink(page,email);assert.ok(link.includes(`&order=${orderId}`));
  await page.goto(link);await expectVisible(page.getByRole('button',{name:/Confirm and sign in/}),'explicit email confirmation');
  assert.ok(!page.url().includes('token='),'token is removed from the address bar');
  assert.equal((await (await page.request.get('/api/ecommerce/account')).json()).account,null,'preview does not consume the link');
  await page.getByRole('button',{name:/Confirm and sign in/}).click();await page.waitForURL(/checkout\/success\?order=/);
  assert.match(await page.locator('[data-receipt-title]').innerText(),/refunded/);
  await expectVisible(page.getByText('JOURNEY-PARCEL-2',{exact:false}),'parcel after cross-device sign-in');
  await page.getByRole('link',{name:'← All your orders',exact:true}).click();
  const card=page.locator(`[data-hub-order="${orderId}"]`);await expectVisible(card,'order in hub');
  assert.match(await card.innerText(),/83.00/);assert.match(await card.innerText(),/Refunded/);assert.match(await card.innerText(),/Shipped/);assert.ok(!(await card.innerText()).includes('open return'),'closed returns are not shown as active');
  assert.match(await card.innerText(),new RegExp(reference));
  const response=await page.request.get('/account');assert.match(response.headers()['cache-control'],/no-store/);
  assert.doesNotMatch(await response.text(),/Private approval|Private warehouse|paymentIntentId|stockTargets/);
  await scan(page,'hub-desktop');await capture('desktop');
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download my account data',exact:true}).click();assert.equal((await downloadPromise).suggestedFilename(),'talisman-account.json');
  // A shopper can revisit the correct product without silently replacing their cart.
  await card.getByRole('link',{name:/Shop this item again/}).click();await expectVisible(page.getByRole('button',{name:/Add to cart/}),'repeat purchase product');await page.goto('/account');
  await page.setViewportSize({width:390,height:844});await scan(page,'hub-mobile');await capture('mobile');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile hub must not overflow');
  // A second customer gets an empty account and cannot read the first customer's order.
  await stranger.goto('/account');const foreignLink=await requestLink(stranger,`hub-other-${ctx.runId}@example.test`);
  await stranger.goto(foreignLink);await stranger.getByRole('button',{name:/Confirm and sign in/}).click();await stranger.waitForURL(/\/account$/);
  await expectVisible(stranger.getByRole('heading',{name:'Your next favourite is out there.'}),'empty account');
  assert.equal((await stranger.request.get(`/api/ecommerce/order?order=${orderId}`)).status(),404);
  await stranger.goto(`/account?order=${orderId}`);assert.match(await stranger.locator('.hub-notice').innerText(),/isn’t available/);
  // Links are single-use and expiry recovery keeps the intended order.
  await stranger.goto(link);await waitUntil('spent link feedback',async()=>/invalid|expired/.test(await stranger.locator('[data-verify-feedback]').innerText()));assert.equal(await stranger.locator('[data-verify-form]').isVisible(),false);
  assert.equal(await stranger.locator('[data-new-signin]').getAttribute('href'),`/account?order=${orderId}`);
  // Staff find exactly the same reference and copy the owner-gated customer link.
  const admin=await ctx.admin.context.newPage();
  await admin.goto('/admin/extensions/commerce-orders');await admin.getByRole('button',{name:'All recent orders',exact:true}).click();await admin.getByLabel('Find an order').fill(reference);await admin.getByRole('button',{name:'Search',exact:true}).click();
  await expectVisible(admin.getByRole('button',{name:'Copy customer link',exact:true}),'staff customer handoff');assert.match(await admin.locator('.ecom-admin__order-customer').innerText(),new RegExp(reference));await admin.close();
  // Verify actual lifecycle messages, including the post-inspection refund, use actionable links.
  const mail=await readFile(log,'utf8'), messages=mail.split('[Talisman CMS] Email not sent (console provider)').filter(m=>m.includes(`To: ${email}\n`));
  const lifecycle=messages.filter(m=>m.includes(reference));
  for(const subject of [/order is confirmed/,/Part of your .* order has shipped/,/rest of your .* order has shipped/,/return request is approved/,/returned goods were received/,/return refund is recorded/,/return request is closed/])assert.ok(lifecycle.some(m=>subject.test(m)),`missing message ${subject}`);
  for(const mail of lifecycle){assert.ok(mail.includes(`/checkout/success?order=${orderId}`));assert.doesNotMatch(mail,/Private approval|Private warehouse|provider may take time/);}
  // All-device revoke invalidates a copied session too; browser back must not restore private history.
  const copied=await ctx.browser.newContext({baseURL:ctx.options.baseUrl,storageState:await context.storageState()});
  await page.goto(`/checkout/success?order=${orderId}`);await page.goto('/account');
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Sign out on all devices',exact:true}).click();await expectVisible(page.getByLabel('Email address',{exact:true}),'signed out');
  assert.equal((await (await copied.request.get('/api/ecommerce/account')).json()).account,null);await copied.close();
  await page.goBack();await waitUntil('private history cleared',async()=>await page.locator('[data-hub-order]').count()===0);
  return 'Fresh-device email link → explicit sign-in → receipt, tracking and refunds → customer hub → repeat shopping → export; mobile, account isolation, single-use links, admin reference search, 7 lifecycle email types, all-device sign-out and history privacy.';
 } catch(error){await capture('failure');throw error;}finally{await context.close();await other.close();}
}
