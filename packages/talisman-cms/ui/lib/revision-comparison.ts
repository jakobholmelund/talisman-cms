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
