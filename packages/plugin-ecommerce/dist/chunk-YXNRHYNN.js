import {
  fulfillments,
  orders
} from "./chunk-CLEUXV3O.js";

// src/fulfillment.ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createDbClient } from "talisman-cms/client";
var fulfillmentSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  carrier: z.string().trim().max(100).nullable(),
  trackingNumber: z.string().trim().max(150).nullable(),
  note: z.string().trim().min(8).max(500)
}).strict();
async function listCommerceOrdersAdmin(env) {
  const db = createDbClient(env);
  const recent = await db.select().from(orders).where(and(
    inArray(orders.status, ["paid", "fulfilled", "partially_refunded"]),
    sql`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`
  )).orderBy(desc(orders.createdAt)).limit(100);
  const shipmentRecords = await db.select().from(fulfillments).orderBy(desc(fulfillments.createdAt)).limit(100);
  return {
    orders: recent,
    fulfillments: shipmentRecords
  };
}
async function fulfillCommerceOrder(env, actor, input) {
  const values = fulfillmentSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const id = `ful_${crypto.randomUUID()}`;
  const db = createDbClient(env);
  await db.insert(fulfillments).values({
    id,
    orderId: values.orderId,
    adminActor: actor,
    carrier: values.carrier,
    trackingNumber: values.trackingNumber,
    note: values.note,
    createdAt: /* @__PURE__ */ new Date()
  });
  const order = await db.select().from(orders).where(eq(orders.id, values.orderId)).get();
  return { fulfillmentId: id, orderId: values.orderId, status: order?.status };
}

export {
  listCommerceOrdersAdmin,
  fulfillCommerceOrder
};
