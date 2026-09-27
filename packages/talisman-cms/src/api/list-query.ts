import type { EntryQuery, Operators, WhereClause } from '../service/query';
import { HttpError } from './http-errors';

/**
 * The list route's query: `where[field]=value`, `where[field][op]=value` (repeat or comma-separate
 * `in` values), `sort=-createdAt,title` and `offset=20`. Values arrive as text and are cast by the
 * field's type in the service, which also checks the field names and operators.
 */
export function parseListQuery(url: URL): EntryQuery {
  const where: WhereClause = {};
  let hasWhere = false;
  for (const [key, value] of url.searchParams) {
    const match = key.match(/^where\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (!match) continue;
    hasWhere = true;
    const [, field, operator] = match;
    if (!operator) {
      where[field] = value;
      continue;
    }
    const current = where[field];
    const operators: Operators = current !== null && typeof current === 'object' ? current as Operators : current === undefined ? {} : { eq: current };
    if (operator === 'in') {
      const previous = Array.isArray(operators.in) ? operators.in : [];
      operators.in = [...previous, ...value.split(',')];
    } else if (operator === 'isNull') {
      operators.isNull = value === 'true' || value === '1' || value === '';
    } else {
      (operators as Record<string, unknown>)[operator] = value;
    }
    where[field] = operators;
  }

  const query: EntryQuery = {};
  if (hasWhere) query.where = where;
  const sort = url.searchParams.get('sort');
  if (sort) query.sort = sort;
  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    if (!/^\d+$/.test(offset)) throw new HttpError(400, 'offset must be a whole number.');
    query.offset = Number(offset);
  }
  return query;
}
