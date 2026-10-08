import React from 'react';
import { revisionRichText, revisionValueLabel } from '../../lib/revision-comparison';

/** Content is always rendered as text. No historical HTML, links, embeds or interactive field widgets. */
export function SnapshotValue({ value, field, depth = 0 }: { value: unknown; field?: any; depth?: number }) {
  if (value === undefined) return <span className="text-zinc-500">Not set</span>;
  if (value === null) return <span className="text-zinc-500">Empty value</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value !== 'object') {
    const option = field?.options?.find((option: any) => typeof option === 'object' && option.value === value);
    return <span className="whitespace-pre-wrap break-words">{option?.label || (value === '' ? 'Empty text' : String(value))}</span>;
  }
  if (depth >= 8) return <span className="text-zinc-500">Nested content exceeds the preview depth.</span>;
  if (field?.type === 'richtext') return <div className="space-y-3">
    <p className="whitespace-pre-wrap break-words">{revisionRichText(value) || 'No text content'}</p>
    <details><summary className="cursor-pointer text-zinc-400">Formatting and structure</summary><SnapshotValue value={value} depth={depth + 1} /></details>
  </div>;
  if (Array.isArray(value)) return value.length === 0 ? <span className="text-zinc-500">No items</span> : <ol className="space-y-3">
    {value.slice(0, 50).map((item: any, index) => {
      const definition = field?.blocks?.find((block: any) => block.slug === item?.blockType) || field?.components?.find((component: any) => component.slug === item?.componentType);
      return <li key={index} className="border-l border-white/10 pl-3">
        <p className="mb-1 text-xs font-medium text-zinc-400">{definition?.name || 'Item'} {index + 1}</p>
        <SnapshotValue value={item} field={definition ? { fields: [...(definition.fields || []), ...(definition.componentSlots || [])] } : field} depth={depth + 1} />
      </li>;
    })}
    {value.length > 50 && <li className="text-zinc-500">{value.length - 50} more items omitted from this preview.</li>}
  </ol>;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length === 0 ? <span className="text-zinc-500">No values</span> : <dl className="space-y-2">
    {keys.slice(0, 50).map(key => {
      const nestedField = field?.fields?.find((candidate: any) => candidate.name === key);
      return <div key={key}><dt className="text-xs text-zinc-400">{nestedField?.label || revisionValueLabel(key)}</dt><dd className="ml-3"><SnapshotValue value={object[key]} field={nestedField} depth={depth + 1} /></dd></div>;
    })}
    {keys.length > 50 && <div><dt className="text-zinc-500">{keys.length - 50} more values omitted from this preview.</dt></div>}
  </dl>;
}

