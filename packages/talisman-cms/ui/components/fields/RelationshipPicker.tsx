import React, { useState } from 'react';
import { Button } from '../ui/button';
import { readCommerceCurrency } from '../../commerce-currency';
import { describeCommerceEntry, getRelationOptionLabel } from '../../lib/commerce-models';
import type { RelationReference } from '../../lib/page-builder';
import {
  getRelationOptionsForField,
  getRelationSelectionKey,
  normalizeRelationSelections,
  serializeRelationSelections,
  type RelationOptions,
  type RelationSupportEntries,
} from './relations';

/** Searches the loaded records of a relation field and holds its selections, in order for hasMany. */
export function RelationshipPicker({
  field,
  value,
  onChange,
  onBlur,
  relationOptions,
  relationSupportEntries,
  labelId,
  describedBy,
}: {
  field: any;
  value: any;
  onChange: (value: any) => void;
  onBlur: () => void;
  relationOptions: RelationOptions;
  relationSupportEntries: RelationSupportEntries;
  /** The id of the field's visible label, which names the picker. */
  labelId?: string;
  describedBy?: string;
}) {
  const [query, setQuery] = useState('');
  const currency = readCommerceCurrency();
  const options = getRelationOptionsForField(field, relationOptions);
  const selections = normalizeRelationSelections(field, value);
  const selectedKeys = new Set(selections.map(getRelationSelectionKey));
  const filteredOptions = options.filter((option) => {
    const label = getRelationOptionLabel(option.collectionSlug, option.entry, relationSupportEntries, currency).toLowerCase();
    const subtitle = describeCommerceEntry(option.collectionSlug, option.entry, relationSupportEntries, currency).subtitle.toLowerCase();
    const search = query.trim().toLowerCase();

    if (!search) return true;
    return label.includes(search) || subtitle.includes(search) || option.collectionSlug.toLowerCase().includes(search);
  });

  function commitSelections(nextSelections: RelationReference[]) {
    onChange(serializeRelationSelections(field, nextSelections));
    onBlur();
  }

  function addSelection(collectionSlug: string, entryId: string) {
    const nextSelection = { relationTo: collectionSlug, value: entryId };
    if (field.hasMany) {
      if (selectedKeys.has(getRelationSelectionKey(nextSelection))) return;
      commitSelections([...selections, nextSelection]);
      return;
    }

    commitSelections([nextSelection]);
  }

  function removeSelection(selectionToRemove: RelationReference) {
    commitSelections(selections.filter((selection) => getRelationSelectionKey(selection) !== getRelationSelectionKey(selectionToRemove)));
  }

  function moveSelection(selectionToMove: RelationReference, direction: -1 | 1) {
    const index = selections.findIndex((selection) => getRelationSelectionKey(selection) === getRelationSelectionKey(selectionToMove));
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= selections.length) return;

    const nextSelections = [...selections];
    const [selection] = nextSelections.splice(index, 1);
    nextSelections.splice(targetIndex, 0, selection);
    commitSelections(nextSelections);
  }

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${field.label.toLowerCase()}...`}
        aria-label={`Search ${field.label}`}
        className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm text-zinc-100 shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      />

      {selections.length > 0 && (
        <div className="space-y-2">
          {selections.map((selection, index) => {
            const entry = (relationSupportEntries[selection.relationTo] || []).find((candidate: any) => candidate.id === selection.value) || null;
            const description = describeCommerceEntry(selection.relationTo, entry, relationSupportEntries, currency);

            return (
              <div key={getRelationSelectionKey(selection)} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                      <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                        {selection.relationTo}
                      </span>
                    </div>
                    {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {field.hasMany && (
                      <>
                        <Button type="button" size="sm" variant="outline" aria-label={`Move ${description.title} up`} onClick={() => moveSelection(selection, -1)} disabled={index === 0}>
                          Up
                        </Button>
                        <Button type="button" size="sm" variant="outline" aria-label={`Move ${description.title} down`} onClick={() => moveSelection(selection, 1)} disabled={index === selections.length - 1}>
                          Down
                        </Button>
                      </>
                    )}
                    <Button type="button" size="sm" variant="destructive" aria-label={`Remove ${description.title}`} onClick={() => removeSelection(selection)}>
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div role="group" aria-label={`${field.label} options`} className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/30">
        {filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">No entries matched this search.</div>
        ) : (
          filteredOptions.map((option) => {
            const description = describeCommerceEntry(option.collectionSlug, option.entry, relationSupportEntries, currency);
            const selection = { relationTo: option.collectionSlug, value: option.entry.id };
            const isSelected = selectedKeys.has(getRelationSelectionKey(selection));

            return (
              <button
                key={`${option.collectionSlug}:${option.entry.id}`}
                type="button"
                onClick={() => addSelection(option.collectionSlug, option.entry.id)}
                disabled={field.hasMany ? isSelected : false}
                className={`flex w-full items-start justify-between gap-4 border-b border-white/5 px-3 py-3 text-left transition-colors last:border-b-0 ${isSelected ? 'bg-indigo-500/10' : 'hover:bg-white/[0.04]'}`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{description.title}</span>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                      {option.collectionSlug}
                    </span>
                  </div>
                  {description.subtitle && <div className="mt-1 text-xs text-zinc-400">{description.subtitle}</div>}
                </div>
                <span className="text-xs text-zinc-400">{isSelected ? 'Selected' : field.hasMany ? 'Add' : 'Choose'}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
