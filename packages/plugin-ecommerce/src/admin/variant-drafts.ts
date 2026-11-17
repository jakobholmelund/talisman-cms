type Value = { localId: string; id: string | null };
type Group = Value & { values: Value[] };
export type SavedVariantDraft = { kind: 'group' | 'value'; localId: string } | 'all' | null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fields = ({ values: _values, ...group }: Group) => group;

/** Refresh only clean or just-saved drafts. Neighboring edits keep their original version tokens,
 * so a concurrent staff edit is still refused by the server instead of silently overwritten. */
export function reconcileVariantDrafts<T extends Group>(baseline: T[], drafts: T[], fresh: T[], saved: SavedVariantDraft = null): T[] {
  if (saved === 'all') return fresh;
  const replaced = (kind: 'group' | 'value', draft: Value) => saved?.kind === kind && saved.localId === draft.localId;
  const result = fresh.map(group => {
    const draft = drafts.find(row => row.id === group.id);
    const before = baseline.find(row => row.id === group.id);
    if (!draft) return group;
    const values = group.values.map(value => {
      const edited = draft.values.find(row => row.id === value.id);
      const original = before?.values.find(row => row.id === value.id);
      return edited && !replaced('value', edited) && !same(edited, original) ? edited : value;
    });
    // New, unsaved values and externally deleted values with unfinished edits stay recoverable.
    for (const value of draft.values) {
      if (values.some(row => row.id !== null && row.id === value.id) || replaced('value', value)) continue;
      const original = before?.values.find(row => row.id === value.id);
      if (!value.id || !same(value, original)) values.push(value);
    }
    return { ...(!replaced('group', draft) && before && !same(fields(draft), fields(before)) ? draft : group), values } as T;
  });
  for (const draft of drafts) {
    if (result.some(row => row.id !== null && row.id === draft.id) || replaced('group', draft)) continue;
    const before = baseline.find(row => row.id === draft.id);
    if (!draft.id || !same(draft, before)) result.push(draft);
  }
  return result;
}

export function variantDraftsChanged(baseline: Group[], drafts: Group[]) {
  return !same(baseline, drafts);
}
