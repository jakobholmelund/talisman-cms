import React, { useState } from 'react';
import { Layers3, Plus, Search, Sparkles, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import {
  getPresetComponentSlug,
  getPresetRecordLabel,
  groupComponentsByLibraryAndCategory,
} from '../lib/page-builder';

type ComponentSlotPickerProps = {
  components: any[] | undefined;
  presetEntries: any[];
  onSelectComponent: (component: any) => void;
  onSelectPreset: (preset: any) => void;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  buttonLabel?: string;
  heading?: string;
  description?: string;
  contextMessage?: string;
};

function matchesComponentQuery(component: any, query: string) {
  if (!query) return true;

  const haystack = [
    component?.name,
    component?.slug,
    component?.description,
    component?.category,
    component?.source?.library,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function matchesPresetQuery(preset: any, query: string) {
  if (!query) return true;

  const data = typeof preset?.data === 'string'
    ? (() => {
        try {
          return JSON.parse(preset.data);
        } catch {
          return {};
        }
      })()
    : (preset?.data || {});

  const haystack = [
    getPresetRecordLabel(preset),
    getPresetComponentSlug(preset),
    data?.variant,
    data?.libraryId,
    preset?.slug,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

export function ComponentSlotPicker({
  components,
  presetEntries,
  onSelectComponent,
  onSelectPreset,
  className,
  open: openProp,
  onOpenChange,
  buttonLabel = 'Add to Slot',
  heading = 'Component Library',
  description = 'Search components and presets for this slot.',
  contextMessage,
}: ComponentSlotPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const open = openProp ?? internalOpen;

  const setOpen = (nextOpen: boolean) => {
    if (openProp === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const filteredComponents = (components || []).filter((component) => matchesComponentQuery(component, query));
  const filteredPresets = (presetEntries || []).filter((preset) => matchesPresetQuery(preset, query));
  const groupedComponents = groupComponentsByLibraryAndCategory(filteredComponents);
  const totalAvailable = filteredComponents.length + filteredPresets.length;

  return (
    <div className={cn('w-full space-y-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">
          {(components?.length || 0) + (presetEntries?.length || 0)} available
        </div>
        <Button
          size="sm"
          variant={open ? 'secondary' : 'outline'}
          type="button"
          className="gap-2"
          onClick={() => {
            setOpen(!open);
            if (open) {
              setQuery('');
            }
          }}
        >
          {open ? <X size={14} /> : <Plus size={14} />}
          {open ? 'Close Library' : buttonLabel}
        </Button>
      </div>

      {open ? (
        <div className="rounded-xl border border-white/10 bg-zinc-950/70 p-4 shadow-[0_20px_80px_rgba(0,0,0,0.25)] backdrop-blur">
          <div className="flex flex-col gap-3 border-b border-white/5 pb-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-100">{heading}</div>
              <div className="mt-1 text-xs text-zinc-400">{description}</div>
              {contextMessage ? <div className="mt-2 text-xs text-indigo-300">{contextMessage}</div> : null}
            </div>
            <div className="relative w-full md:max-w-sm">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search components or presets..."
                className="pl-9"
              />
            </div>
          </div>

          <div className="mt-4 max-h-[32rem] space-y-5 overflow-y-auto pr-1">
            {totalAvailable === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
                <div className="text-sm font-medium text-zinc-200">No matching items</div>
                <div className="mt-1 text-xs text-zinc-500">Try a different search term.</div>
              </div>
            ) : null}

            {filteredPresets.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
                    <Sparkles size={12} />
                    Presets
                  </div>
                  <div className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-500">
                    {filteredPresets.length} {filteredPresets.length === 1 ? 'preset' : 'presets'}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {filteredPresets.map((preset: any) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        onSelectPreset(preset);
                        setOpen(false);
                        setQuery('');
                      }}
                      className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-left transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/[0.08]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-100">{getPresetRecordLabel(preset)}</div>
                          <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                            {getPresetComponentSlug(preset) || 'Preset'}
                          </div>
                        </div>
                        <div className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
                          Preset
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {groupedComponents.length > 0 ? (
              <div className="space-y-5">
                {groupedComponents.map((libraryGroup: any) => (
                  <div key={libraryGroup.library} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
                        <Layers3 size={12} />
                        {libraryGroup.library}
                      </div>
                      <div className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-500">
                        {libraryGroup.categories.reduce((count: number, categoryGroup: any) => count + categoryGroup.components.length, 0)} items
                      </div>
                    </div>
                    {libraryGroup.categories.map((categoryGroup: any) => (
                      <div key={`${libraryGroup.library}-${categoryGroup.category}`} className="space-y-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                          {categoryGroup.category}
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          {categoryGroup.components.map((component: any) => (
                            <button
                              key={component.slug}
                              type="button"
                              onClick={() => {
                                onSelectComponent(component);
                                setOpen(false);
                                setQuery('');
                              }}
                              className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-left transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/[0.08]"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-zinc-100">{component.name}</div>
                                  <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                                    {component.slug}
                                  </div>
                                </div>
                                <div className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-200">
                                  Component
                                </div>
                              </div>
                              {component.description ? (
                                <div className="mt-3 text-sm leading-relaxed text-zinc-400">
                                  {component.description}
                                </div>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
