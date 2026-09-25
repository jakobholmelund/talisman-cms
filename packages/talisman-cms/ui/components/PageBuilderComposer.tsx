import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Layers3,
  LayoutPanelLeft,
  Plus,
} from 'lucide-react';
import { BlockLibraryPicker } from './BlockLibraryPicker';
import { ComponentSlotPicker } from './ComponentSlotPicker';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import {
  buildBlockValue,
  buildInlineComponentValue,
  buildPresetReferenceValue,
  getBlockPreviewSummary,
  getCollapsedCardsStorageKey,
  getComponentPreviewSummary,
  getComponentSlotItems,
  getPresetComponentSlug,
  getPresetRecordLabel,
  insertArrayItem,
  isPresetReferenceValue,
  moveArrayItem,
  readCollapsedCardsState,
  writeCollapsedCardsState,
} from '../lib/page-builder';

type SelectedNode =
  | { kind: 'block'; blockIndex: number }
  | { kind: 'slot-item'; blockIndex: number; slotName: string; itemIndex: number };

type DragState = {
  listId: string;
  index: number;
} | null;

type PageBuilderComposerProps = {
  field: any;
  fieldName: string;
  form: any;
  relationSupportEntries: Record<string, any[]>;
  collapseStorageKey?: string;
  renderField: (field: any, basePath: string) => React.ReactNode;
};

function reorderFieldArrayValue(fieldApi: any, fromIndex: number, toIndex: number) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  const nextValue = moveArrayItem(currentValue, fromIndex, toIndex);

  if (nextValue === currentValue) {
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

function insertFieldArrayValue(fieldApi: any, index: number, nextValue: any) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  fieldApi.handleChange(insertArrayItem(currentValue, index, nextValue));
  fieldApi.handleBlur();
}

function addSlotValue(slot: any, fieldApi: any, nextValue: any) {
  if (slot.hasMany) {
    fieldApi.pushValue(nextValue);
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

function removeSlotValue(slot: any, fieldApi: any, index: number) {
  if (slot.hasMany) {
    fieldApi.removeValue(index);
    return;
  }

  fieldApi.handleChange(null);
  fieldApi.handleBlur();
}

function insertSlotValue(slot: any, fieldApi: any, index: number | null, nextValue: any) {
  if (!slot.hasMany || index === null) {
    addSlotValue(slot, fieldApi, nextValue);
    return;
  }

  insertFieldArrayValue(fieldApi, index, nextValue);
}

function getAllowedPresetEntries(slot: any, presetEntries: any[]) {
  const allowedComponentSlugs = new Set((slot.components || []).map((component: any) => component.slug));
  return presetEntries.filter((preset) => allowedComponentSlugs.has(getPresetComponentSlug(preset)));
}

function isSelectionValid(selection: SelectedNode | null, value: any[], blocks: any[] | undefined) {
  if (!selection) return false;

  const blockValue = value[selection.blockIndex];
  const blockDef = blocks?.find((block: any) => block.slug === blockValue?.blockType);
  if (!blockDef) return false;

  if (selection.kind === 'block') {
    return true;
  }

  const slot = (blockDef.componentSlots || []).find((candidate: any) => candidate.name === selection.slotName);
  if (!slot) return false;

  const slotItems = getComponentSlotItems(slot, blockValue?.[selection.slotName]);
  return selection.itemIndex >= 0 && selection.itemIndex < slotItems.length;
}

function getDefaultSelection(value: any[]) {
  // We explicitly start with no selection so the inspector isn't open by default.
  return null;
}

function FieldSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-4">
      <div>
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        {description ? <div className="mt-1 text-xs text-zinc-400">{description}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function EmptyInspectorState() {
  return (
    <div className="flex min-h-[18rem] items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 text-center">
      <div>
        <div className="text-sm font-medium text-zinc-200">Select a block or component</div>
        <div className="mt-2 text-sm leading-relaxed text-zinc-500">
          Use the outline to choose the part of the page you want to edit.
        </div>
      </div>
    </div>
  );
}

function EmptyOutlineState() {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
      <div className="text-sm font-medium text-zinc-200">No blocks added yet</div>
      <div className="mt-2 text-sm leading-relaxed text-zinc-500">
        Start the page by adding a layout or content block from the library.
      </div>
    </div>
  );
}

function BuilderPanel({
  field,
  fieldName,
  fieldApi,
  form,
  relationSupportEntries,
  collapseStorageKey,
  renderField,
}: PageBuilderComposerProps & { fieldApi: any }) {
  const value = fieldApi.state.value || [];
  const [dragState, setDragState] = useState<DragState>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(getDefaultSelection(value));
  const [blockLibraryOpen, setBlockLibraryOpen] = useState(false);
  const [pendingBlockInsertIndex, setPendingBlockInsertIndex] = useState<number | null>(null);
  const [slotPickerState, setSlotPickerState] = useState<Record<string, { open: boolean; insertIndex: number | null }>>({});
  const fieldCollapseStorageKey = getCollapsedCardsStorageKey(collapseStorageKey, fieldName);
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>(() => readCollapsedCardsState(fieldCollapseStorageKey));

  const getCardKey = (listId: string, index: number) => `${listId}:${index}`;
  const isCardCollapsed = (listId: string, index: number) => collapsedCards[getCardKey(listId, index)] === true;

  const toggleCardCollapsed = (listId: string, index: number) => {
    const cardKey = getCardKey(listId, index);
    setCollapsedCards((current) => ({
      ...current,
      [cardKey]: !current[cardKey],
    }));
  };

  const setListCollapsed = (listId: string, count: number, collapsed: boolean) => {
    setCollapsedCards((current) => {
      const nextState = { ...current };
      for (let index = 0; index < count; index += 1) {
        nextState[getCardKey(listId, index)] = collapsed;
      }
      return nextState;
    });
  };

  const getSlotPickerConfig = (slotFieldName: string) => slotPickerState[slotFieldName] || { open: false, insertIndex: null };

  const openSlotPicker = (slotFieldName: string, insertIndex: number | null) => {
    setSlotPickerState((current) => ({
      ...current,
      [slotFieldName]: { open: true, insertIndex },
    }));
  };

  const closeSlotPicker = (slotFieldName: string) => {
    setSlotPickerState((current) => ({
      ...current,
      [slotFieldName]: { open: false, insertIndex: null },
    }));
  };

  useEffect(() => {
    setCollapsedCards(readCollapsedCardsState(fieldCollapseStorageKey));
  }, [fieldCollapseStorageKey]);

  useEffect(() => {
    writeCollapsedCardsState(fieldCollapseStorageKey, collapsedCards);
  }, [collapsedCards, fieldCollapseStorageKey]);

  useEffect(() => {
    if (isSelectionValid(selectedNode, value, field.blocks)) {
      return;
    }

    setSelectedNode(getDefaultSelection(value));
  }, [field.blocks, selectedNode, value]);

  const insertBlockAtIndex = (index: number | null, block: any) => {
    const nextBlockValue = buildBlockValue(block);
    const insertIndex = index === null ? value.length : index;

    if (index === null) {
      fieldApi.pushValue(nextBlockValue);
    } else {
      insertFieldArrayValue(fieldApi, index, nextBlockValue);
    }

    setSelectedNode({ kind: 'block', blockIndex: insertIndex });
    setPendingBlockInsertIndex(null);
    setBlockLibraryOpen(false);
  };

  const selectedBlockValue = selectedNode ? value[selectedNode.blockIndex] : null;
  const selectedBlockDef = selectedBlockValue
    ? field.blocks?.find((block: any) => block.slug === selectedBlockValue?.blockType)
    : null;

  const selectedSlot =
    selectedNode?.kind === 'slot-item' && selectedBlockDef
      ? (selectedBlockDef.componentSlots || []).find((slot: any) => slot.name === selectedNode.slotName)
      : null;

  const selectedSlotItems =
    selectedSlot && selectedBlockValue
      ? getComponentSlotItems(selectedSlot, selectedBlockValue[selectedSlot.name])
      : [];

  const selectedSlotItem =
    selectedNode?.kind === 'slot-item'
      ? selectedSlotItems[selectedNode.itemIndex] || null
      : null;

  const selectedComponentDef =
    selectedNode?.kind === 'slot-item' && selectedSlot && selectedSlotItem && !isPresetReferenceValue(selectedSlotItem)
      ? (selectedSlot.components || []).find((component: any) => component.slug === selectedSlotItem.componentType) || null
      : null;

  const selectedPresetEntry =
    selectedNode?.kind === 'slot-item' && isPresetReferenceValue(selectedSlotItem)
      ? (relationSupportEntries._ui_component_presets || []).find((preset: any) => preset.id === selectedSlotItem.presetId) || null
      : null;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-zinc-950/40 p-4 shadow-inner">
          <div className="flex items-start justify-between gap-4 border-b border-white/5 pb-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <LayoutPanelLeft size={16} />
                {field.label}
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Arrange blocks and nested slot components from one outline.
              </div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-400">
              {value.length} {value.length === 1 ? 'block' : 'blocks'}
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {value.length > 0 ? (
                <>
                  <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(fieldName, value.length, true)}>
                    Collapse All
                  </Button>
                  <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(fieldName, value.length, false)}>
                    Expand All
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                type="button"
                className="gap-2"
                onClick={() => {
                  setPendingBlockInsertIndex(null);
                  setBlockLibraryOpen(true);
                }}
              >
                <Plus size={14} />
                Add Block
              </Button>
            </div>

            <BlockLibraryPicker
              blocks={field.blocks}
              open={blockLibraryOpen}
              onOpenChange={(nextOpen) => {
                setBlockLibraryOpen(nextOpen);
                if (!nextOpen) {
                  setPendingBlockInsertIndex(null);
                }
              }}
              buttonLabel={pendingBlockInsertIndex === null ? 'Add Block' : 'Insert Block'}
              contextMessage={pendingBlockInsertIndex === null ? undefined : `Choose a block to insert at position ${pendingBlockInsertIndex + 1}.`}
              onSelect={(block) => insertBlockAtIndex(pendingBlockInsertIndex, block)}
            />

            {value.length === 0 ? (
              <EmptyOutlineState />
            ) : (
              <div className="space-y-3">
                {value.map((blockValue: any, blockIndex: number) => {
                  const blockDef = field.blocks?.find((candidate: any) => candidate.slug === blockValue?.blockType);
                  if (!blockDef) return null;

                  const blockSummary = getBlockPreviewSummary(blockDef, blockValue, relationSupportEntries);
                  const blockSelected = selectedNode?.kind === 'block' && selectedNode.blockIndex === blockIndex;
                  const blockCollapsed = isCardCollapsed(fieldName, blockIndex);

                  return (
                    <div
                      key={`${blockValue?.blockType || 'block'}-${blockIndex}`}
                      draggable
                      onDragStart={() => setDragState({ listId: fieldName, index: blockIndex })}
                      onDragEnd={() => setDragState(null)}
                      onDragOver={(event) => {
                        if (dragState?.listId === fieldName && dragState.index !== blockIndex) {
                          event.preventDefault();
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragState?.listId === fieldName && dragState.index !== blockIndex) {
                          reorderFieldArrayValue(fieldApi, dragState.index, blockIndex);
                          setSelectedNode({ kind: 'block', blockIndex });
                        }
                        setDragState(null);
                      }}
                      className={cn(
                        'rounded-2xl border p-4 transition-colors',
                        blockSelected ? 'border-indigo-400/40 bg-indigo-500/[0.08]' : 'border-white/10 bg-white/[0.02]',
                        dragState?.listId === fieldName && dragState.index === blockIndex ? 'ring-1 ring-indigo-400/30' : '',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedNode({ kind: 'block', blockIndex })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedNode({ kind: 'block', blockIndex });
                            }
                          }}
                          className="flex min-w-0 flex-1 items-start gap-3 text-left"
                        >
                          <div
                            draggable
                            onDragStart={() => setDragState({ listId: fieldName, index: blockIndex })}
                            onDragEnd={() => setDragState(null)}
                            className="mt-0.5 flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-zinc-500 active:cursor-grabbing"
                            title="Drag to reorder block"
                          >
                            <GripVertical size={14} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleCardCollapsed(fieldName, blockIndex);
                                }}
                                className="flex items-center gap-1 text-zinc-500"
                                aria-label={blockCollapsed ? 'Expand block' : 'Collapse block'}
                              >
                                {blockCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                              </button>
                              <div className="text-sm font-medium text-zinc-100">{blockDef.name}</div>
                              {blockDef.source?.library ? (
                                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                                  {blockDef.source.library}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-zinc-500">{blockDef.slug}</div>
                            {blockSummary.length > 0 ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {blockSummary.map((summary: string, summaryIndex: number) => (
                                  <span key={`${fieldName}-${blockIndex}-${summaryIndex}`} className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-400">
                                    {summary}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            onClick={() => {
                              setPendingBlockInsertIndex(blockIndex);
                              setBlockLibraryOpen(true);
                            }}
                          >
                            Add Above
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            onClick={() => {
                              setPendingBlockInsertIndex(blockIndex + 1);
                              setBlockLibraryOpen(true);
                            }}
                          >
                            Add Below
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            className="h-8 w-8 p-0"
                            onClick={() => {
                              reorderFieldArrayValue(fieldApi, blockIndex, blockIndex - 1);
                              setSelectedNode({ kind: 'block', blockIndex: blockIndex - 1 });
                            }}
                            disabled={blockIndex === 0}
                            title="Move block up"
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            className="h-8 w-8 p-0"
                            onClick={() => {
                              reorderFieldArrayValue(fieldApi, blockIndex, blockIndex + 1);
                              setSelectedNode({ kind: 'block', blockIndex: blockIndex + 1 });
                            }}
                            disabled={blockIndex === value.length - 1}
                            title="Move block down"
                          >
                            <ArrowDown size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            type="button"
                            onClick={() => {
                              fieldApi.removeValue(blockIndex);
                              setSelectedNode(value.length > 1 ? { kind: 'block', blockIndex: Math.max(0, blockIndex - 1) } : null);
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>

                      {!blockCollapsed ? (
                        <div className="mt-4 space-y-3 border-t border-white/5 pt-4">
                          {(blockDef.componentSlots || []).map((slot: any) => {
                            const slotFieldName = `${fieldName}[${blockIndex}].${slot.name}`;
                            const presetEntries = getAllowedPresetEntries(slot, relationSupportEntries._ui_component_presets || []);
                            const slotItems = getComponentSlotItems(slot, blockValue?.[slot.name]);
                            const slotPickerConfig = getSlotPickerConfig(slotFieldName);

                            return (
                              <form.Field
                                key={slotFieldName}
                                name={slotFieldName}
                                {...(slot.hasMany ? { mode: 'array' as const } : {})}
                                children={(slotApi: any) => (
                                  <div className="rounded-xl border border-white/8 bg-black/20 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      <div>
                                        <div className="text-sm font-medium text-zinc-200">{slot.label}</div>
                                        {slot.description ? <div className="mt-1 text-xs text-zinc-500">{slot.description}</div> : null}
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        {slot.hasMany && slotItems.length > 0 ? (
                                          <>
                                            <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(slotFieldName, slotItems.length, true)}>
                                              Collapse All
                                            </Button>
                                            <Button size="sm" variant="outline" type="button" onClick={() => setListCollapsed(slotFieldName, slotItems.length, false)}>
                                              Expand All
                                            </Button>
                                          </>
                                        ) : null}
                                        <Button size="sm" variant="outline" type="button" onClick={() => openSlotPicker(slotFieldName, slotItems.length)}>
                                          {slot.hasMany ? 'Add to Slot' : slotItems.length > 0 ? 'Replace' : 'Add to Slot'}
                                        </Button>
                                      </div>
                                    </div>

                                    <div className="mt-3">
                                      <ComponentSlotPicker
                                        components={slot.components}
                                        presetEntries={slot.allowReferences ? presetEntries : []}
                                        open={slotPickerConfig.open}
                                        onOpenChange={(nextOpen) => {
                                          if (nextOpen) {
                                            openSlotPicker(slotFieldName, slotPickerConfig.insertIndex);
                                          } else {
                                            closeSlotPicker(slotFieldName);
                                          }
                                        }}
                                        buttonLabel={slotPickerConfig.insertIndex === null ? 'Add to Slot' : 'Insert Item'}
                                        contextMessage={slotPickerConfig.insertIndex === null ? undefined : `Choose an item to insert at position ${slotPickerConfig.insertIndex + 1}.`}
                                        onSelectComponent={(component) => {
                                          const insertIndex = slot.hasMany
                                            ? (slotPickerConfig.insertIndex ?? slotItems.length)
                                            : 0;
                                          insertSlotValue(slot, slotApi, slotPickerConfig.insertIndex, buildInlineComponentValue(component));
                                          setSelectedNode({
                                            kind: 'slot-item',
                                            blockIndex,
                                            slotName: slot.name,
                                            itemIndex: insertIndex,
                                          });
                                          closeSlotPicker(slotFieldName);
                                        }}
                                        onSelectPreset={(preset) => {
                                          const insertIndex = slot.hasMany
                                            ? (slotPickerConfig.insertIndex ?? slotItems.length)
                                            : 0;
                                          insertSlotValue(slot, slotApi, slotPickerConfig.insertIndex, buildPresetReferenceValue(preset.id));
                                          setSelectedNode({
                                            kind: 'slot-item',
                                            blockIndex,
                                            slotName: slot.name,
                                            itemIndex: insertIndex,
                                          });
                                          closeSlotPicker(slotFieldName);
                                        }}
                                      />
                                    </div>

                                    <div className="mt-3 space-y-2">
                                      {slotItems.length === 0 ? (
                                        <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-sm text-zinc-500">
                                          No components added yet.
                                        </div>
                                      ) : (
                                        slotItems.map((slotItem: any, slotIndex: number) => {
                                          const slotSelected =
                                            selectedNode?.kind === 'slot-item' &&
                                            selectedNode.blockIndex === blockIndex &&
                                            selectedNode.slotName === slot.name &&
                                            selectedNode.itemIndex === slotIndex;

                                          const slotCardCollapsed = isCardCollapsed(slotFieldName, slotIndex);
                                          const presetEntry = isPresetReferenceValue(slotItem)
                                            ? (relationSupportEntries._ui_component_presets || []).find((preset: any) => preset.id === slotItem.presetId) || null
                                            : null;
                                          const componentDef = !isPresetReferenceValue(slotItem)
                                            ? (slot.components || []).find((component: any) => component.slug === slotItem?.componentType) || null
                                            : null;
                                          const componentSummary = componentDef
                                            ? getComponentPreviewSummary(componentDef, slotItem, relationSupportEntries)
                                            : [];
                                          const itemLabel = presetEntry
                                            ? getPresetRecordLabel(presetEntry)
                                            : componentDef?.name || slotItem?.componentType || 'Unknown item';
                                          const itemMeta = presetEntry
                                            ? getPresetComponentSlug(presetEntry) || 'Preset reference'
                                            : componentDef?.source?.library || componentDef?.slug || 'Inline component';

                                          return (
                                            <div
                                              key={`${slotFieldName}-${slotIndex}`}
                                              draggable={slot.hasMany}
                                              onDragStart={() => {
                                                if (slot.hasMany) {
                                                  setDragState({ listId: slotFieldName, index: slotIndex });
                                                }
                                              }}
                                              onDragEnd={() => setDragState(null)}
                                              onDragOver={(event) => {
                                                if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                                  event.preventDefault();
                                                }
                                              }}
                                              onDrop={(event) => {
                                                event.preventDefault();
                                                if (slot.hasMany && dragState?.listId === slotFieldName && dragState.index !== slotIndex) {
                                                  reorderFieldArrayValue(slotApi, dragState.index, slotIndex);
                                                  setSelectedNode({
                                                    kind: 'slot-item',
                                                    blockIndex,
                                                    slotName: slot.name,
                                                    itemIndex: slotIndex,
                                                  });
                                                }
                                                setDragState(null);
                                              }}
                                              className={cn(
                                                'rounded-xl border p-3 transition-colors',
                                                slotSelected ? 'border-indigo-400/40 bg-indigo-500/[0.08]' : 'border-white/8 bg-white/[0.02]',
                                                dragState?.listId === slotFieldName && dragState.index === slotIndex ? 'ring-1 ring-indigo-400/30' : '',
                                              )}
                                            >
                                              <div className="flex items-start justify-between gap-3">
                                                <div
                                                  role="button"
                                                  tabIndex={0}
                                                  onClick={() => setSelectedNode({ kind: 'slot-item', blockIndex, slotName: slot.name, itemIndex: slotIndex })}
                                                  onKeyDown={(event) => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                      event.preventDefault();
                                                      setSelectedNode({ kind: 'slot-item', blockIndex, slotName: slot.name, itemIndex: slotIndex });
                                                    }
                                                  }}
                                                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                                                >
                                                  {slot.hasMany ? (
                                                    <div
                                                      draggable
                                                      onDragStart={() => setDragState({ listId: slotFieldName, index: slotIndex })}
                                                      onDragEnd={() => setDragState(null)}
                                                      className="mt-0.5 flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-zinc-500 active:cursor-grabbing"
                                                      title="Drag to reorder item"
                                                    >
                                                      <GripVertical size={14} />
                                                    </div>
                                                  ) : null}
                                                  <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                      <button
                                                        type="button"
                                                        onClick={(event) => {
                                                          event.stopPropagation();
                                                          toggleCardCollapsed(slotFieldName, slotIndex);
                                                        }}
                                                        className="flex items-center gap-1 text-zinc-500"
                                                        aria-label={slotCardCollapsed ? 'Expand item' : 'Collapse item'}
                                                      >
                                                        {slotCardCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                                                      </button>
                                                      <div className="text-sm font-medium text-zinc-100">{itemLabel}</div>
                                                    </div>
                                                    <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-zinc-500">{itemMeta}</div>
                                                    {!slotCardCollapsed && componentSummary.length > 0 ? (
                                                      <div className="mt-3 flex flex-wrap gap-2">
                                                        {componentSummary.map((summary: string, summaryIndex: number) => (
                                                          <span key={`${slotFieldName}-${slotIndex}-${summaryIndex}`} className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-400">
                                                            {summary}
                                                          </span>
                                                        ))}
                                                      </div>
                                                    ) : null}
                                                  </div>
                                                </div>

                                                <div className="flex flex-wrap justify-end gap-2">
                                                  {slot.hasMany ? (
                                                    <>
                                                      <Button size="sm" variant="outline" type="button" onClick={() => openSlotPicker(slotFieldName, slotIndex)}>
                                                        Add Above
                                                      </Button>
                                                      <Button size="sm" variant="outline" type="button" onClick={() => openSlotPicker(slotFieldName, slotIndex + 1)}>
                                                        Add Below
                                                      </Button>
                                                      <Button
                                                        size="sm"
                                                        variant="outline"
                                                        type="button"
                                                        className="h-8 w-8 p-0"
                                                        onClick={() => {
                                                          reorderFieldArrayValue(slotApi, slotIndex, slotIndex - 1);
                                                          setSelectedNode({
                                                            kind: 'slot-item',
                                                            blockIndex,
                                                            slotName: slot.name,
                                                            itemIndex: slotIndex - 1,
                                                          });
                                                        }}
                                                        disabled={slotIndex === 0}
                                                        title="Move item up"
                                                      >
                                                        <ArrowUp size={14} />
                                                      </Button>
                                                      <Button
                                                        size="sm"
                                                        variant="outline"
                                                        type="button"
                                                        className="h-8 w-8 p-0"
                                                        onClick={() => {
                                                          reorderFieldArrayValue(slotApi, slotIndex, slotIndex + 1);
                                                          setSelectedNode({
                                                            kind: 'slot-item',
                                                            blockIndex,
                                                            slotName: slot.name,
                                                            itemIndex: slotIndex + 1,
                                                          });
                                                        }}
                                                        disabled={slotIndex === slotItems.length - 1}
                                                        title="Move item down"
                                                      >
                                                        <ArrowDown size={14} />
                                                      </Button>
                                                    </>
                                                  ) : null}
                                                  <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    type="button"
                                                    onClick={() => {
                                                      removeSlotValue(slot, slotApi, slotIndex);
                                                      setSelectedNode({ kind: 'block', blockIndex });
                                                    }}
                                                  >
                                                    Remove
                                                  </Button>
                                                </div>
                                              </div>
                                            </div>
                                          );
                                        })
                                      )}
                                    </div>
                                  </div>
                                )}
                              />
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedNode && selectedBlockDef && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6" style={{ pointerEvents: 'auto' }}>
          <div 
            className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity" 
            onClick={() => setSelectedNode(null)} 
            aria-hidden="true"
          />
          <div className="relative z-[101] flex w-full max-w-2xl max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
            <div className="shrink-0 flex items-center justify-between border-b border-white/10 bg-zinc-950/80 px-6 py-4 backdrop-blur-md">
              <h2 className="text-lg font-semibold text-white">Inspector</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelectedNode(null)} className="h-8 rounded-full px-3 text-zinc-400 hover:text-white hover:bg-white/10">
                Close
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {selectedNode.kind === 'block' ? (
              <>
                <div className="border-b border-white/5 pb-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                    <Layers3 size={12} />
                    Block Inspector
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-semibold text-white">{selectedBlockDef.name}</h3>
                    {selectedBlockDef.source?.library ? (
                      <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-zinc-400">
                        {selectedBlockDef.source.library}
                      </span>
                    ) : null}
                  </div>
                  {selectedBlockDef.description ? <p className="mt-2 text-sm leading-relaxed text-zinc-400">{selectedBlockDef.description}</p> : null}
                </div>

                {selectedBlockDef.fields?.length ? (
                  <FieldSection title="Block Fields" description="Edit the selected block's content and configuration.">
                    {selectedBlockDef.fields.map((subField: any) => renderField(subField, `${fieldName}[${selectedNode.blockIndex}]`))}
                  </FieldSection>
                ) : null}

                {selectedBlockDef.componentSlots?.length ? (
                  <FieldSection title="Slots" description="Add and arrange nested components from the outline on the left.">
                    <div className="grid gap-3 md:grid-cols-2">
                      {selectedBlockDef.componentSlots.map((slot: any) => {
                        const slotItems = getComponentSlotItems(slot, selectedBlockValue?.[slot.name]);
                        return (
                          <div key={`${fieldName}-${selectedNode.blockIndex}-${slot.name}`} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                            <div className="text-sm font-medium text-zinc-100">{slot.label}</div>
                            {slot.description ? <div className="mt-1 text-xs text-zinc-500">{slot.description}</div> : null}
                            <div className="mt-3 text-xs uppercase tracking-[0.2em] text-zinc-500">
                              {slotItems.length} {slotItems.length === 1 ? 'item' : 'items'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </FieldSection>
                ) : null}
              </>
            ) : selectedComponentDef && selectedSlot ? (
              <>
                <div className="border-b border-white/5 pb-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Component Inspector</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-semibold text-white">{selectedComponentDef.name}</h3>
                    {selectedComponentDef.source?.library ? (
                      <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-zinc-400">
                        {selectedComponentDef.source.library}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 text-sm text-zinc-400">
                    Editing <span className="text-zinc-200">{selectedSlot.label}</span> in <span className="text-zinc-200">{selectedBlockDef.name}</span>.
                  </div>
                  {selectedComponentDef.description ? <p className="mt-2 text-sm leading-relaxed text-zinc-400">{selectedComponentDef.description}</p> : null}
                </div>

                <FieldSection title="Component Fields" description="Edit the selected component's props.">
                  {selectedComponentDef.fields.map((componentField: any) =>
                    renderField(
                      componentField,
                      selectedSlot.hasMany
                        ? `${fieldName}[${selectedNode.blockIndex}].${selectedNode.slotName}[${selectedNode.itemIndex}]`
                        : `${fieldName}[${selectedNode.blockIndex}].${selectedNode.slotName}`,
                    )
                  )}
                </FieldSection>
              </>
            ) : selectedPresetEntry && selectedSlot ? (
              <>
                <div className="border-b border-white/5 pb-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Preset Reference</div>
                  <h3 className="mt-2 text-xl font-semibold text-white">{getPresetRecordLabel(selectedPresetEntry)}</h3>
                  <div className="mt-2 text-sm text-zinc-400">
                    This slot item points to a reusable preset instead of inline component props.
                  </div>
                </div>

                <FieldSection title="Preset Details" description="Preset references are managed from the presets collection.">
                  <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Component</div>
                    <div className="mt-2 text-sm text-zinc-100">{getPresetComponentSlug(selectedPresetEntry) || 'Unknown component'}</div>
                    <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-zinc-500">Slot</div>
                    <div className="mt-2 text-sm text-zinc-100">{selectedSlot.label}</div>
                  </div>
                </FieldSection>
              </>
            ) : null}
            </div>
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

export function PageBuilderComposer(props: PageBuilderComposerProps) {
  const { fieldName, form } = props;

  return (
    <form.Field
      name={fieldName}
      mode="array"
      children={(fieldApi: any) => <BuilderPanel {...props} fieldApi={fieldApi} />}
    />
  );
}
