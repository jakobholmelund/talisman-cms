import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { orders } from './schema';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(`${s}T00:00:00Z`))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s,'Use a valid calendar date');
const options=z.object({kind:z.enum(['orders','returns','stock']),from:day,to:day,orderId:z.string().trim().max(128).default(''),status:z.enum(['all','draft','pending','paid','fulfilled','cancelled','partially_refunded','refunded','disputed']).default('all'),targetType:z.enum(['all','product','variant','stock','component']).default('all'),targetId:z.string().trim().max(128).default('')}).strict()
  .refine(v=>v.to>=v.from&&Date.parse(`${v.to}T00:00:00Z`)-Date.parse(`${v.from}T00:00:00Z`)<366*86400000,'Choose at most 366 UTC days')
  .refine(v=>(v.kind==='orders'||v.status==='all')&&(v.kind==='stock'||(v.targetType==='all'&&!v.targetId))&&(!v.targetId||v.targetType!=='all'),'Filters do not match the selected export');
export class OperationsExportLimit extends Error {}
type Cell=string|number|null;
function csvCell(value:Cell) {
  if(value===null)return '""';
  let s=String(value);
  // Quoting alone does not stop spreadsheet formula evaluation. Numeric deltas remain numbers.
  if(typeof value==='string'&&/^[\s\u0000-\u001f]*[=+\-@]/.test(s))s=`'${s}`;
  return `"${s.replaceAll('"','""')}"`;
}
/** A complete bounded download. Never silently truncate a larger selection. */
export async function exportCommerceOperations(env:TalismanEnv,input:unknown) {
  const v=options.parse(input),db=commerceDb(env),from=Date.parse(`${v.from}T00:00:00Z`)/1000,to=Date.parse(`${v.to}T00:00:00Z`)/1000+86400;
  let rows:Array<Record<string,Cell>>,columns:string[];
  if(v.kind==='orders') {
    columns=['order_id','created_at_utc','payment_status','fulfillment_status','currency','subtotal_minor','shipping_minor','tax_minor','discount_minor','credit_minor','gift_card_minor','total_minor','provider_refunded_minor','gift_card_refunded_minor','customer_email'];
    rows=await db.select({order_id:orders.id,created_at_utc:sql<number>`${orders.createdAt}`,
      payment_status:orders.status,fulfillment_status:orders.fulfillmentStatus,currency:orders.currency,
      subtotal_minor:orders.subtotalAmount,shipping_minor:orders.shippingAmount,tax_minor:orders.taxAmount,
      discount_minor:orders.discountAmount,credit_minor:orders.creditApplied,gift_card_minor:orders.giftCardApplied,
      total_minor:orders.totalAmount,provider_refunded_minor:orders.providerRefundedCents,
      gift_card_refunded_minor:orders.giftCardRefundedCents,customer_email:orders.customerEmail})
      .from(orders).where(and(gte(orders.createdAt,new Date(from*1000)),lt(orders.createdAt,new Date(to*1000)),
        sql`COALESCE(${orders.paymentProvider},'stripe')<>'admin_test'`,v.orderId?eq(orders.id,v.orderId):undefined,
        v.status==='all'?undefined:eq(orders.status,v.status))).orderBy(asc(orders.createdAt),asc(orders.id)).limit(1001).all();
  } else if(v.kind==='returns') {
    columns=['receipt_id','request_id','order_id','created_at_utc','line_index','quantity','condition','restock_selected','awaiting_inspection','actor','reason'];
    rows=await db.all<Record<string,Cell>>(sql`SELECT r.id AS receipt_id,l.request_id,r.order_id,r.created_at AS created_at_utc,json_extract(i.value,'$.lineIndex') AS line_index,json_extract(i.value,'$.quantity') AS quantity,json_extract(i.value,'$.condition') AS condition,json_extract(i.value,'$.restock') AS restock_selected,
    CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN json_extract(i.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) a WHERE d.receipt_id=r.id AND json_extract(a.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0) ELSE 0 END AS awaiting_inspection,r.actor,r.reason
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_receipts l ON l.receipt_id=r.id,json_each(r.items) i
    WHERE r.created_at>=${from} AND r.created_at<${to} AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND (${v.orderId}='' OR r.order_id=${v.orderId}) ORDER BY r.created_at,r.id,line_index LIMIT 1001`);
  } else {
    columns=['movement_id','created_at_utc','kind','target_type','target_id','delta','before_quantity','after_quantity','order_id','actor','reason'];
    const inventory=sql`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,r.target_type,r.target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout stock reservation' AS reason FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release',r.target_type,r.target_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout stock release' FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id)`;
    const component=sql`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,'component' AS target_type,r.component_id AS target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout component reservation' AS reason FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release','component',r.component_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout component release' FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id)`;
    const restored=sql`SELECT s.id AS movement_id,r.created_at AS created_at_utc,'return' AS kind,s.target_type,s.target_id,s.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,s.order_id,r.actor,r.reason FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id=s.receipt_id
      UNION ALL SELECT s.id,r.created_at,'inspection',s.target_type,s.target_id,s.quantity,NULL,NULL,s.order_id,r.actor,r.reason FROM _ecommerce_inspection_stock s JOIN _ecommerce_return_inspections r ON r.id=s.inspection_id`;
    rows=await db.all<Record<string,Cell>>(sql`WITH inventory AS (${inventory}),component AS (${component}),restored AS (${restored}),events AS (
      SELECT id AS movement_id,created_at AS created_at_utc,kind,target_type,target_id,delta,before_quantity,after_quantity,NULL AS order_id,actor,reason FROM _ecommerce_stock_movements
      UNION ALL SELECT * FROM restored
      UNION ALL SELECT id,created_at,'restock',target_type,target_id,quantity,NULL,NULL,order_id,admin_actor,reason FROM _ecommerce_restocks
      UNION ALL SELECT * FROM inventory UNION ALL SELECT * FROM component)
      SELECT * FROM events WHERE (order_id IS NULL OR EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=events.order_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')) AND created_at_utc>=${from} AND created_at_utc<${to} AND (${v.orderId}='' OR order_id=${v.orderId}) AND (${v.targetType}='all' OR target_type=${v.targetType}) AND (${v.targetId}='' OR target_id=${v.targetId}) ORDER BY created_at_utc,movement_id LIMIT 1001`);
  }
  if(rows.length>1000)throw new OperationsExportLimit('This selection exceeds 1,000 rows. Narrow the dates or filters; no partial file was created.');
  for(const row of rows)row.created_at_utc=new Date(Number(row.created_at_utc)*1000).toISOString();
  return {filename:`commerce-${v.kind}-${v.from}-${v.to}.csv`,rows:rows.length,csv:'\uFEFF'+[columns.map(csvCell).join(','),...rows.map(row=>columns.map(c=>csvCell(row[c]??null)).join(','))].join('\r\n')+'\r\n'};
}
