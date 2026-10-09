import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, commitBatch, errorText } from './db';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { supplierIssues, supplierIssueEvents, SUPPLIER_ISSUE_KINDS, SUPPLIER_ISSUE_STATUSES } from './schema';
import { adminActorNames } from './admin-actors';

const id = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(8).max(500);
/** An issue aliased as i remains open independently of its purchase/delivery state. */
export const openSupplierIssue = sql`COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open')='open'`;
async function identity(input: { requestKey: string }, actor: string, prefix: string) {
  if (!actor.trim()) throw new CommerceOperationsConflict('An authenticated staff member is required.');
  return { id: `${prefix}_${await hashOrderAccess(input.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function guarded<T>(write: () => Promise<unknown>, replay: () => Promise<T | null>) {
  try { await write(); } catch (error) {
    const previous = await replay(); if (previous) return previous;
    if (!/Supplier issue|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict('The purchase, delivery or supplier issue changed. Refresh before continuing.');
  }
  return null;
}
export async function reportSupplierIssue(env: TalismanEnv, input: unknown, actor: string) {
  const v = z.object({ purchaseLineId: id, expectedPurchaseVersion: id, expectedDeliveryVersion: id,
    kind: z.enum(SUPPLIER_ISSUE_KINDS), quantity: z.number().int().min(1).max(1000000), reason, requestKey: id.min(8) }).strict().parse(input);
  const db = commerceDb(env), ident = await identity(v, actor, 'supissue');
  const replay = async () => {
    const row = await db.select().from(supplierIssues).where(eq(supplierIssues.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict('This supplier issue key was used with different details.');
    return { issueId: row.id, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssues).values({ ...fields, ...ident, actor, createdAt: new Date() })]), replay);
  return result ?? { issueId: ident.id };
}
export async function recordSupplierIssue(env: TalismanEnv, input: unknown, actor: string) {
  const v = z.object({ issueId: id, expectedVersion: id, status: z.enum(SUPPLIER_ISSUE_STATUSES), reason, requestKey: id.min(8) }).strict().parse(input);
  const db = commerceDb(env), ident = await identity(v, actor, 'supissueevent');
  const replay = async () => {
    const row = await db.select().from(supplierIssueEvents).where(eq(supplierIssueEvents.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict('This supplier follow-up key was used with different details.');
    return { issueId: row.issueId, eventId: row.id, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssueEvents).values({ ...fields, ...ident, actor, createdAt: new Date() })]), replay);
  return result ?? { issueId: v.issueId, eventId: ident.id };
}
const queue = sql`WITH issues AS (SELECT i.id,i.purchase_line_id AS purchaseLineId,i.kind,i.quantity,i.created_at AS createdAt,
 COALESCE((SELECT id FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),i.id) AS version,
 COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 l.purchase_order_id AS purchaseOrderId,l.delivery_id AS deliveryId,l.line_index AS lineIndex,e.reference,
 json_extract(e.supplier,'$.name') AS supplier,json_extract(e.lines,'$['||l.line_index||'].name') AS name
 FROM _ecommerce_supplier_issues i JOIN _ecommerce_purchase_order_lines l ON l.id=i.purchase_line_id
 JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=l.purchase_order_id ORDER BY rowid DESC LIMIT 1))`;
export async function listSupplierIssues(env: TalismanEnv, input: unknown = {}) {
  const v = z.object({ purchaseOrderId: id.optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0),
    filter: z.enum(['open', 'resolved', 'all']).default('open') }).strict().parse(input), db = commerceDb(env);
  const where = sql`(${v.purchaseOrderId ?? null} IS NULL OR purchaseOrderId=${v.purchaseOrderId ?? null}) AND (${v.filter}='all' OR status=${v.filter})`;
  const [rows, count] = await db.batch([
    db.all<{ id: string; purchaseLineId: string; kind: typeof SUPPLIER_ISSUE_KINDS[number]; quantity: number; createdAt: number; version: string;
      status: typeof SUPPLIER_ISSUE_STATUSES[number]; purchaseOrderId: string; deliveryId: string; lineIndex: number; reference: string; supplier: string; name: string }>(sql`${queue} SELECT * FROM issues WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),
    db.all<{ n: number }>(sql`${queue} SELECT count(*) AS n FROM issues WHERE ${where}`),
  ]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map(row => ({ ...row, createdAt: new Date(row.createdAt * 1000).toISOString() })) };
}
export async function readSupplierIssue(env: TalismanEnv, input: unknown) {
  const { issueId } = z.object({ issueId: id }).strict().parse(input), db = commerceDb(env);
  const issue = await db.query.supplierIssues.findFirst({ where: { id: issueId }, with: {
    events: { orderBy: (_t, { sql }) => sql`rowid DESC`, limit: 100 },
    line: { with: { purchaseOrder: { with: { events: { orderBy: (_t, { sql }) => sql`rowid DESC`, limit: 1 } } } } },
  } });
  if (!issue) throw new CommerceOperationsConflict('Supplier issue not found.');
  const latest = issue.events[0], purchase = issue.line.purchaseOrder.events[0];
  const actors = await adminActorNames(env, [issue.actor, ...issue.events.map(e => e.actor)]);
  return { id: issue.id, purchaseLineId: issue.purchaseLineId, purchaseOrderId: issue.line.purchaseOrderId,
    kind: issue.kind, quantity: issue.quantity, reason: issue.reason, createdAt: issue.createdAt.toISOString(), actorName: actors.get(issue.actor) ?? issue.actor,
    version: latest?.id ?? issue.id, status: latest?.status ?? 'open', reference: purchase.reference,
    name: purchase.lines[issue.line.lineIndex].name, supplier: purchase.supplier.name,
    historyTruncated: issue.events.length === 100,
    history: [...issue.events].reverse().map(e => ({ id: e.id, status: e.status, reason: e.reason, actorName: actors.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() })),
  };
}
