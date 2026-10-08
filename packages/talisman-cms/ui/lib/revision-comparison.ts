export type RevisionFieldComparison = {
  name: string;
  label: string;
  field: any;
  before: unknown;
  after: unknown;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
};

export function revisionData(snapshot: { data?: unknown }): Record<string, unknown> {
  const data = typeof snapshot.data === 'string' ? JSON.parse(snapshot.data) : snapshot.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This snapshot does not contain readable entry content.');
  return data;
}

/** JSON objects compare by keys/values, while array order remains significant. No recursive stack. */
export function equalRevisionValues(before: unknown, after: unknown): boolean {
  const pending: [unknown, unknown][] = [[before, after]];
  while (pending.length) {
    const [left, right] = pending.pop()!;
    if (left === right) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index++) pending.push([left[index], right[index]]);
    } else {
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(right, key)) return false;
        pending.push([(left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]]);
      }
    }
  }
  return true;
}

export function revisionValueLabel(name: string): string {
  const labels: Record<string, string> = { blockType: 'Block', componentType: 'Component', type: 'Type', attrs: 'Settings', marks: 'Formatting', content: 'Content', text: 'Text' };
  return Object.hasOwn(labels, name) ? labels[name] : name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

export function compareRevisionFields(fields: any[], before: Record<string, unknown>, after: Record<string, unknown>): RevisionFieldComparison[] {
  const names = [...new Set([...fields.map(field => field.name), ...Object.keys(before), ...Object.keys(after)])];
  return names.map(name => {
    const field = fields.find(candidate => candidate.name === name);
    const hasBefore = Object.hasOwn(before, name);
    const hasAfter = Object.hasOwn(after, name);
    const oldValue = hasBefore ? before[name] : undefined;
    const newValue = hasAfter ? after[name] : undefined;
    return { name, label: field?.label || revisionValueLabel(name), field, before: oldValue, after: newValue,
      change: hasBefore !== hasAfter ? hasBefore ? 'removed' : 'added' : equalRevisionValues(oldValue, newValue) ? 'unchanged' : 'changed' };
  });
}

/** Plain text preview; formatting/attributes remain available in the structured read-only details. */
export function revisionRichText(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  const pending: any[] = [value];
  while (pending.length) {
    const node = pending.pop();
    if (node === '\n') { parts.push('\n'); continue; }
    if (!node || typeof node !== 'object') continue;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) {
      if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type)) pending.push('\n');
      for (let index = node.content.length - 1; index >= 0; index--) pending.push(node.content[index]);
    }
  }
  return parts.join('').trim();
}

export type ConflictSnapshot = { data: Record<string, unknown>; slug?: string };
export type ConflictChoice = 'mine' | 'latest';
/** Match saved JSON: optional undefined form settings are not changes to stored objects. */
export function conflictSnapshotData(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(values));
}
/** Capture only edited top-level JSON fields, including explicit removals. */
export function conflictFieldChanges(baseline: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const snapshot = conflictSnapshotData(values);
  return Object.fromEntries(compareRevisionFields([], baseline, snapshot).filter(row => row.change !== 'unchanged').map(row => [row.name, row.after]));
}
export type ConflictFieldReview = {
  key: string;
  name: string;
  label: string;
  field: any;
  original: unknown;
  mine: unknown;
  latest: unknown;
  kind: 'overlap' | 'mine-only' | 'already-saved';
};

function sameField(left: Record<string, unknown>, right: Record<string, unknown>, name: string) {
  const hasLeft = Object.hasOwn(left, name), hasRight = Object.hasOwn(right, name);
  return hasLeft === hasRight && equalRevisionValues(hasLeft ? left[name] : undefined, hasRight ? right[name] : undefined);
}

/** Apply only explicit changes, preserving removed fields and keys such as __proto__ as data. */
export function withFieldChanges(data: Record<string, unknown>, changes: Record<string, unknown>) {
  const values = new Map(Object.entries(data));
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) values.delete(name);
    else values.set(name, value);
  }
  return Object.fromEntries(values);
}

/** Whole top-level fields are atomic: blocks/arrays are never silently merged by position. */
export function compareConflictFields(fields: any[], original: ConflictSnapshot, mine: ConflictSnapshot, latest: ConflictSnapshot, editedFields: string[] = []): ConflictFieldReview[] {
  const edited = new Set(editedFields);
  const rows = compareRevisionFields([...fields, ...editedFields.map(name => ({ name }))], original.data, mine.data).filter(row => row.change !== 'unchanged' || edited.has(row.name)).map(row => ({
    key: `data:${row.name}`, name: row.name, label: row.label, field: row.field,
    original: row.before, mine: row.after, latest: Object.hasOwn(latest.data, row.name) ? latest.data[row.name] : undefined,
    kind: sameField(mine.data, latest.data, row.name) ? 'already-saved' : sameField(original.data, latest.data, row.name) ? 'mine-only' : 'overlap',
  } as ConflictFieldReview));
  if (mine.slug !== original.slug) rows.unshift({
    key: 'entry-slug', name: 'slug', label: 'URL slug', field: { type: 'text' }, original: original.slug, mine: mine.slug, latest: latest.slug,
    kind: mine.slug === latest.slug ? 'already-saved' : original.slug === latest.slug ? 'mine-only' : 'overlap',
  });
  return rows;
}

/** Refuse unresolved overlaps. Fields changed only by other writers retain their latest value. */
export function applyConflictChoices(latest: ConflictSnapshot, mine: ConflictSnapshot, rows: ConflictFieldReview[], choices: Record<string, ConflictChoice>): ConflictSnapshot {
  const result: ConflictSnapshot = { ...latest, data: { ...latest.data } };
  const changes: Record<string, unknown> = Object.create(null);
  for (const row of rows) {
    const selected = Object.hasOwn(choices, row.key) ? choices[row.key] : row.kind === 'mine-only' ? 'mine' : row.kind === 'already-saved' ? 'latest' : undefined;
    if (selected !== 'mine' && selected !== 'latest') throw new Error(`Choose a value for ${row.label}.`);
    if (selected === 'latest') continue;
    if (row.key === 'entry-slug') result.slug = mine.slug;
    else changes[row.name] = Object.hasOwn(mine.data, row.name) ? mine.data[row.name] : undefined;
  }
  result.data = withFieldChanges(result.data, changes);
  return result;
}
