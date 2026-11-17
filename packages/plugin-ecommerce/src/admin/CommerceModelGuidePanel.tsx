import React from 'react';
import type { AdminEditorPanelProps } from 'talisman-cms/ui/components/editor/panels';
import { productsCollectionSlug } from 'virtual:talisman-cms/ecommerce-admin';
import { getCommerceFlowSummary, getCommerceModelGuide } from './commerce-models';

/**
 * The editor panel above the fields of a commerce record: how the record fits the product flow
 * (product, variant group, value, stock) and which related records the current values point at.
 * Products get the Options & stock panel instead of a guide.
 */
export default function CommerceModelGuidePanel({ collection, values, relationSupportEntries, isNew }: AdminEditorPanelProps) {
  if (collection.slug === productsCollectionSlug || collection.nativeSchemaMapping?.exportName === 'products') return isNew ? <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-4"><h2 className="text-sm font-semibold text-white">Let’s create your product</h2><p className="mt-2 text-sm text-zinc-300">Start with a name, price and photos. Create the product, then add sizes, colours and starting stock.</p><p className="mt-2 text-xs text-zinc-400">Keep it as a draft until you’re ready for shoppers to see it.</p></div> : <nav aria-label="Product sections" className="flex flex-wrap gap-2 border-b border-white/10 pb-4 text-sm text-indigo-200">
    <a href="#entry-fields" className="rounded-lg bg-white/5 px-3 py-2 hover:bg-white/10">Product details</a>
    <a href="#commerce-product-options" className="rounded-lg bg-white/5 px-3 py-2 hover:bg-white/10">Variants & inventory</a>
    <a href="#commerce-product-preview" onClick={() => { const preview = document.getElementById('commerce-product-preview') as HTMLDetailsElement | null; if (preview) preview.open = true; }} className="rounded-lg bg-white/5 px-3 py-2 hover:bg-white/10">Preview</a>
    <a href="#entry-save-actions" className="rounded-lg bg-white/5 px-3 py-2 hover:bg-white/10">Save product details</a>
  </nav>;
  const guide = getCommerceModelGuide(collection.slug);
  const flowSummary = getCommerceFlowSummary(collection.slug, values, relationSupportEntries);

  if (!guide && flowSummary.length === 0) return null;

  return (
    <div className="space-y-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-5">
      {guide && (
        <>
          <div>
            <h2 className="text-sm font-semibold text-sky-100">{guide.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-sky-50/80">{guide.body}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {guide.steps.map((step, index) => (
              <span key={`${step}-${index}`} className="rounded-full border border-sky-400/20 bg-black/20 px-2.5 py-1 text-[11px] uppercase tracking-wider text-sky-100/90">
                {index + 1}. {step}
              </span>
            ))}
          </div>
        </>
      )}
      {flowSummary.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {flowSummary.map((item) => (
            <div key={item.label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] text-sky-100/60">{item.label}</div>
              <div className="mt-1 text-sm text-white">{item.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
