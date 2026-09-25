import React, { useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { groupBlocksByCategory } from '../lib/page-builder';
import { cn } from '../lib/utils';

type BlockLibraryPickerProps = {
  blocks: any[] | undefined;
  onSelect: (block: any) => void;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  buttonLabel?: string;
  heading?: string;
  description?: string;
  contextMessage?: string;
};

function matchesBlockQuery(block: any, query: string) {
  if (!query) return true;

  const haystack = [
    block?.name,
    block?.slug,
    block?.description,
    block?.category,
    block?.source?.library,
    ...(Array.isArray(block?.tags) ? block.tags : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

export function BlockLibraryPicker({
  blocks,
  onSelect,
  className,
  open: openProp,
  onOpenChange,
  buttonLabel = 'Add Block',
  heading = 'Block Library',
  description = 'Search blocks by name, category, library, or tag.',
  contextMessage,
}: BlockLibraryPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const open = openProp ?? internalOpen;

  const setOpen = (nextOpen: boolean) => {
    if (openProp === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const filteredBlocks = (blocks || []).filter((block) => matchesBlockQuery(block, query));
  const groupedBlocks = groupBlocksByCategory(filteredBlocks);

  return (
    <div className={cn('w-full space-y-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">
          {blocks?.length || 0} available
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
                placeholder="Search blocks..."
                className="pl-9"
              />
            </div>
          </div>

          <div className="mt-4 max-h-[32rem] space-y-5 overflow-y-auto pr-1">
            {groupedBlocks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
                <div className="text-sm font-medium text-zinc-200">No matching blocks</div>
                <div className="mt-1 text-xs text-zinc-500">Try a different search term.</div>
              </div>
            ) : (
              groupedBlocks.map((group) => (
                <div key={group.category} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
                      {group.category}
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-500">
                      {group.blocks.length} {group.blocks.length === 1 ? 'block' : 'blocks'}
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {group.blocks.map((block: any) => (
                      <button
                        key={block.slug}
                        type="button"
                        onClick={() => {
                          onSelect(block);
                          setOpen(false);
                          setQuery('');
                        }}
                        className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-left transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/[0.08]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-zinc-100">{block.name}</div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                              {block.slug}
                            </div>
                          </div>
                          {block.source?.library ? (
                            <div className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-200">
                              {block.source.library}
                            </div>
                          ) : null}
                        </div>
                        {block.description ? (
                          <div className="mt-3 text-sm leading-relaxed text-zinc-400">
                            {block.description}
                          </div>
                        ) : null}
                        {Array.isArray(block.tags) && block.tags.length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {block.tags.slice(0, 3).map((tag: string) => (
                              <span
                                key={`${block.slug}-${tag}`}
                                className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-400"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
