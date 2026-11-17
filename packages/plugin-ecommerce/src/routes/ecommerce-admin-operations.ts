import { readAdminCatalogue, readCatalogueSelection, updateCatalogue } from '../catalog-admin';
import { readOrderRecoveryHistory } from '../recovery-journal';
import type { APIRoute } from 'astro';
import type { TalismanEnv } from 'talisman-cms/client';
import { authorizeCmsRequest } from 'talisman-cms/auth/guard';
import { OperationsExportLimit } from '../operations-export';
import { readBoundedJson } from '../request-body';
import { ShopperError } from '../shopper-errors';
import { deliverCommerceEmail } from '../commerce-emails';
import type { CommerceEmailKind } from '../email-deliveries';
import { z, ZodError } from 'zod';
import { readExchangeHandoff, receiveReplacementReturn, inspectReplacementReturn, verifyExchangeCharge, createRecoveryCase, recordRecoveryEvent, shipRecoveryCase, listRecoveryCases, readRecoveryCase, readRecoveryOrder, listExchangeChoices, listSupplierIssues, readSupplierIssue, reportSupplierIssue, recordSupplierIssue, readOperationsReport, listSuppliers, saveSupplier, listPurchaseOrders, readPurchaseOrder, savePurchaseOrder, recordPurchaseOrder, listRefundFollowUp, readRefundCase, recordRefundFollowUp, listReplenishment, readReplenishment, saveReplenishmentPolicy, planReplenishmentDelivery, recordReplenishmentDelivery, CommerceOperationsConflict, decideReturnRequest, readReturnRequestAdmin, listReturnsQueue, exportCommerceOperations, readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, inspectOrderReturn, recordStocktake, listStocktakes, readStocktakeTargets, listEmailRecovery, readCommerceAttention, readStockOverview, retryCommerceEmail } from '../operations';

export const ALL: APIRoute = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, 'admin');
  if (authorization.response) return authorization.response;
  const headers = { 'Cache-Control': 'no-store' };
  if (!['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  const url = new URL(request.url);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) {
    return Response.json({ error: 'Same-origin request required' }, { status: 403, headers });
  }
  let catalogueRequest = url.searchParams.get('view') === 'catalogue';
  try {
    const { env, waitUntil } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv;
    if (request.method === 'GET') {
      const { view, ...params } = Object.fromEntries(url.searchParams);
      if (view === 'catalogue') return Response.json(await readAdminCatalogue(runtimeEnv, params), { headers });
      if (view === 'recoveries') return Response.json(await listRecoveryCases(runtimeEnv, params), { headers });
      if (view === 'supplierIssues') return Response.json(await listSupplierIssues(runtimeEnv, params), { headers });
      if (view === 'report') return Response.json(await readOperationsReport(runtimeEnv, params), { headers });
      if (view === 'suppliers') return Response.json(await listSuppliers(runtimeEnv, params), { headers });
      if (view === 'purchaseOrders') return Response.json(await listPurchaseOrders(runtimeEnv, params), { headers });
      if (view === 'attention') return Response.json(await readCommerceAttention(runtimeEnv), { headers });
      if (view === 'emails') return Response.json(await listEmailRecovery(runtimeEnv, params), { headers });
      if (view === 'stockLocations') return Response.json(await listStockLocations(runtimeEnv, params), { headers });
      if (view === 'refunds') return Response.json(await listRefundFollowUp(runtimeEnv, params), { headers });
      if (view === 'replenishment') return Response.json(await listReplenishment(runtimeEnv, params), { headers });
      if (view === 'returns') return Response.json(await listReturnsQueue(runtimeEnv, params), { headers });
      if (view === 'stocktakes') return Response.json(await listStocktakes(runtimeEnv, params), { headers });
      if (view === 'stockHistory') return Response.json(await readStockHistory(runtimeEnv, params), { headers });
      if (view === 'stock') return Response.json(await readStockOverview(runtimeEnv, { ...params, view: params.inventory }), { headers });
      return Response.json({ error: 'Choose an operations view' }, { status: 400, headers });
    }
    let body: { action?: string; data?: unknown };
    try { body = z.object({action:z.string().optional(),data:z.unknown().optional()}).strict().parse(await readBoundedJson(request)); } catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers }); }
    catalogueRequest = body.action === 'catalogueSelection' || body.action === 'catalogueUpdate';
    const actor = String(authorization.user?.id ?? '');
    if (body?.action === 'export') { const result = await exportCommerceOperations(runtimeEnv, body.data); return new Response(result.csv, { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.filename}"`, 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(result.rows) } }); }
    if(body?.action==='catalogueSelection') return Response.json(await readCatalogueSelection(runtimeEnv,body.data),{headers});
    if(body?.action==='catalogueUpdate') return Response.json({result:await updateCatalogue(runtimeEnv,body.data,actor)},{headers});
    if(body?.action==='orderRecoveryHistory')return Response.json(await readOrderRecoveryHistory(runtimeEnv,body.data),{headers});
    if (body?.action === 'exchangeHandoff') return Response.json(await readExchangeHandoff(runtimeEnv, body.data), { headers });
    if (body?.action === 'recoveryRead') return Response.json(await readRecoveryCase(runtimeEnv, body.data), { headers });
    if (body?.action === 'recoveryOrderRead') return Response.json(await readRecoveryOrder(runtimeEnv, body.data), { headers });
    if (body?.action === 'exchangeChoices') return Response.json(await listExchangeChoices(runtimeEnv, body.data), { headers });
    if (body?.action === 'supplierIssueRead') return Response.json(await readSupplierIssue(runtimeEnv, body.data), { headers });
    if (body?.action === 'purchaseOrderRead') return Response.json(await readPurchaseOrder(runtimeEnv, body.data), { headers });
    if (body?.action === 'refundRead') return Response.json(await readRefundCase(runtimeEnv, body.data), { headers });
    if (body?.action === 'replenishmentRead') return Response.json(await readReplenishment(runtimeEnv, body.data), { headers });
    if (body?.action === 'returnRequestRead') return Response.json(await readReturnRequestAdmin(runtimeEnv, body.data), { headers });
    if (body?.action === 'stocktakeRead') return Response.json(await readStocktakeTargets(runtimeEnv, body.data), { headers });
    if (body?.action === 'warehouseRead') return Response.json(await readOrderWarehouse(runtimeEnv, body.data), { headers });
    const actions = { recoveryReceive:receiveReplacementReturn, recoveryInspect:inspectReplacementReturn, recoveryPayment:verifyExchangeCharge, recoveryCreate: createRecoveryCase, recoveryAction: recordRecoveryEvent, recoveryShip: shipRecoveryCase, supplierIssueReport: reportSupplierIssue, supplierIssueAction: recordSupplierIssue, supplierSave: saveSupplier, purchaseOrderSave: savePurchaseOrder, purchaseOrderAction: recordPurchaseOrder, refundDecision: recordRefundFollowUp, replenishmentPolicy: saveReplenishmentPolicy, replenishmentPlan: planReplenishmentDelivery, replenishmentReceive: recordReplenishmentDelivery, retryEmail: retryCommerceEmail, parcelContents: recordParcelContents, receiveReturn: receiveOrderReturn, stockMovement: recordStockMovement, inspectReturn: inspectOrderReturn, stocktake: recordStocktake, returnDecision: decideReturnRequest };
    const action = body?.action as keyof typeof actions;
    if (!Object.hasOwn(actions, action)) return Response.json({ error: 'Invalid operations action' }, { status: 400, headers });
    const result = await actions[action](runtimeEnv, body.data, actor);
    // The operation has already committed its outbox row atomically. Try it now without delaying
    // staff; leases/idempotency and scheduled retries still own delivery and recovery.
    let notice: [CommerceEmailKind, string] | undefined;
    if (action === 'returnDecision' && 'eventId' in result) notice = ['return_decision', result.eventId];
    if (action === 'receiveReturn' && 'receiptId' in result) notice = ['return_received', result.receiptId];
    if (action === 'refundDecision' && 'decisionId' in result) notice = ['return_refund', result.decisionId];
    if (action === 'recoveryShip' && 'shipmentId' in result) notice = ['recovery_shipment', result.shipmentId];
    if (action === 'recoveryAction' && 'eventId' in result) notice = ['recovery_tracking', result.eventId];
    if (action === 'recoveryReceive' && 'receiptId' in result) notice = ['recovery_received', result.receiptId];
    if (notice) {
      const delivery = deliverCommerceEmail(runtimeEnv, ...notice);
      if (typeof waitUntil === 'function') waitUntil(delivery);
      else await delivery;
    }
    return Response.json({ result }, { headers });
  } catch (error) {
    if (error instanceof OperationsExportLimit) return Response.json({ error: error.message }, { status: 413, headers });
    if (error instanceof ShopperError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof ZodError) return Response.json({ error: catalogueRequest ? 'Check your product selection, prices and visibility, then try again.' : 'Check the supplied fields and give a reason of 8 to 500 characters.' }, { status: 400, headers });
    if (error instanceof CommerceOperationsConflict) return Response.json({ error: error.message }, { status: 409, headers });
    console.error('[commerce:operations] Request failed', error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.name : 'Unknown error');
    return Response.json({ error: 'Commerce operations could not be loaded or saved. Try again.' }, { status: 500, headers });
  }
};
