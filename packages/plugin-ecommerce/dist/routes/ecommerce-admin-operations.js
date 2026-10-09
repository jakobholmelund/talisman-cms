import {
  readBoundedJson
} from "../chunk-RPRVGONJ.js";
import {
  OperationsExportLimit,
  exportCommerceOperations,
  listRefundFollowUp,
  listReplenishment,
  planReplenishmentDelivery,
  readCommerceAttention,
  readRefundCase,
  readReplenishment,
  readStockOverview,
  recordRefundFollowUp,
  recordReplenishmentDelivery,
  saveReplenishmentPolicy
} from "../chunk-4M4YC56X.js";
import {
  decideReturnRequest,
  listReturnsQueue,
  readReturnRequestAdmin
} from "../chunk-UR52F5YS.js";
import "../chunk-BFCTU77S.js";
import "../chunk-BGDJXEM5.js";
import {
  CommerceOperationsConflict,
  inspectOrderReturn,
  listEmailRecovery,
  listStockLocations,
  listStocktakes,
  readOrderWarehouse,
  readStockHistory,
  readStocktakeTargets,
  receiveOrderReturn,
  recordParcelContents,
  recordStockMovement,
  recordStocktake,
  retryCommerceEmail
} from "../chunk-RLJNYAC6.js";
import {
  ShopperError
} from "../chunk-5CEWEWY2.js";
import "../chunk-L6PZD3R6.js";
import "../chunk-GNU6N22K.js";
import "../chunk-DIRLX3FV.js";
import "../chunk-WUDMFQXC.js";
import "../chunk-OX54ZSQZ.js";
import "../chunk-NQUBOBQT.js";
import "../chunk-E6QRZBC6.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-admin-operations.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { z, ZodError } from "zod";
var ALL = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "no-store" };
  if (!["GET", "POST"].includes(request.method)) return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") {
      const { view, ...params } = Object.fromEntries(url.searchParams);
      if (view === "attention") return Response.json(await readCommerceAttention(runtimeEnv), { headers });
      if (view === "emails") return Response.json(await listEmailRecovery(runtimeEnv, params), { headers });
      if (view === "stockLocations") return Response.json(await listStockLocations(runtimeEnv, params), { headers });
      if (view === "refunds") return Response.json(await listRefundFollowUp(runtimeEnv, params), { headers });
      if (view === "replenishment") return Response.json(await listReplenishment(runtimeEnv, params), { headers });
      if (view === "returns") return Response.json(await listReturnsQueue(runtimeEnv, params), { headers });
      if (view === "stocktakes") return Response.json(await listStocktakes(runtimeEnv, params), { headers });
      if (view === "stockHistory") return Response.json(await readStockHistory(runtimeEnv, params), { headers });
      if (view === "stock") return Response.json(await readStockOverview(runtimeEnv, { ...params, view: params.inventory }), { headers });
      return Response.json({ error: "Choose an operations view" }, { status: 400, headers });
    }
    let body;
    try {
      body = z.object({ action: z.string().optional(), data: z.unknown().optional() }).strict().parse(await readBoundedJson(request));
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400, headers });
    }
    const actor = String(authorization.user?.id ?? "");
    if (body?.action === "export") {
      const result = await exportCommerceOperations(runtimeEnv, body.data);
      return new Response(result.csv, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"`, "X-Content-Type-Options": "nosniff", "X-Export-Rows": String(result.rows) } });
    }
    if (body?.action === "refundRead") return Response.json(await readRefundCase(runtimeEnv, body.data), { headers });
    if (body?.action === "replenishmentRead") return Response.json(await readReplenishment(runtimeEnv, body.data), { headers });
    if (body?.action === "returnRequestRead") return Response.json(await readReturnRequestAdmin(runtimeEnv, body.data), { headers });
    if (body?.action === "stocktakeRead") return Response.json(await readStocktakeTargets(runtimeEnv, body.data), { headers });
    if (body?.action === "warehouseRead") return Response.json(await readOrderWarehouse(runtimeEnv, body.data), { headers });
    const actions = { refundDecision: recordRefundFollowUp, replenishmentPolicy: saveReplenishmentPolicy, replenishmentPlan: planReplenishmentDelivery, replenishmentReceive: recordReplenishmentDelivery, retryEmail: retryCommerceEmail, parcelContents: recordParcelContents, receiveReturn: receiveOrderReturn, stockMovement: recordStockMovement, inspectReturn: inspectOrderReturn, stocktake: recordStocktake, returnDecision: decideReturnRequest };
    const action = body?.action;
    if (!Object.hasOwn(actions, action)) return Response.json({ error: "Invalid operations action" }, { status: 400, headers });
    return Response.json({ result: await actions[action](runtimeEnv, body.data, actor) }, { headers });
  } catch (error) {
    if (error instanceof OperationsExportLimit) return Response.json({ error: error.message }, { status: 413, headers });
    if (error instanceof ShopperError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof ZodError) return Response.json({ error: "Check the supplied fields and give a reason of 8 to 500 characters." }, { status: 400, headers });
    if (error instanceof CommerceOperationsConflict) return Response.json({ error: error.message }, { status: 409, headers });
    console.error("[commerce:operations] Request failed", error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.name : "Unknown error");
    return Response.json({ error: "Commerce operations could not be loaded or saved. Try again." }, { status: 500, headers });
  }
};
export {
  ALL
};
