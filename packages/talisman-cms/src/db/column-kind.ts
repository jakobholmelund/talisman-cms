/** What a Drizzle column holds, read from its `dataType`. */
export type ColumnKind = 'date' | 'number' | 'boolean' | 'json' | 'string' | 'other';

/**
 * The kind of value a Drizzle column holds. Drizzle 1.0 names the data types `'object date'`,
 * `'number int53'`, `'object json'` and `'string enum'`; 0.45 named them `'date'`, `'number'`, `'json'`
 * and `'string'`. Both spellings are read, so native tables map the same whichever release defined them.
 */
export function columnKind(column: unknown): ColumnKind {
  const dataType = (column as { dataType?: unknown } | null | undefined)?.dataType;
  if (typeof dataType !== 'string') return 'other';
  if (/^(object )?(date|timestamp)\b/.test(dataType)) return 'date';
  if (/^(number|integer|real|bigint)\b/.test(dataType)) return 'number';
  if (dataType === 'boolean') return 'boolean';
  if (/^(object )?json\b/.test(dataType)) return 'json';
  if (/^string\b/.test(dataType)) return 'string';
  return 'other';
}
