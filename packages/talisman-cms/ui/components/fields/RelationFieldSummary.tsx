import React from 'react';
import { describeEntry } from '../../lib/entry-describers';
import { isPolymorphicRelationField } from '../../lib/page-builder';
import { normalizeRelationSelections, type RelationSupportEntries } from './relations';

/** The records a relation field points at, described from the loaded data, under the picker. */
export function RelationFieldSummary({
  field,
  value,
  relationSupportEntries,
}: {
  field: any;
  value: any;
  relationSupportEntries: RelationSupportEntries;
}) {
  const selections = normalizeRelationSelections(field, value);
  if (!field.relationTo || selections.length === 0) {
    return null;
  }

  const selectedEntries = selections
    .map((selection) => ({
      collectionSlug: selection.relationTo,
      entry: (relationSupportEntries[selection.relationTo] || []).find((option: any) => option.id === selection.value) || null,
      value: selection.value,
    }));

  if (selectedEntries.every((selection) => !selection.entry)) {
    return (
      <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
        Selected relation could not be resolved from the current dataset.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selectedEntries.map((selection) => {
        if (!selection.entry) {
          return (
            <div key={`${selection.collectionSlug}:${selection.value}`} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Missing record in <span className="font-semibold">{selection.collectionSlug}</span>: {selection.value}
            </div>
          );
        }

        const description = describeEntry(selection.collectionSlug, selection.entry, relationSupportEntries);
        return (
          <div key={`${selection.collectionSlug}:${selection.entry.id}`} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-zinc-100">{description.title}</div>
              {isPolymorphicRelationField(field) && (
                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {selection.collectionSlug}
                </span>
              )}
            </div>
            {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
            {description.details.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {description.details.map((detail) => (
                  <span key={detail} className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-zinc-300">
                    {detail}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
