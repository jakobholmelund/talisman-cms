import React from 'react';
import { Link } from '@tanstack/react-router';
import type { AdminSectionWorkspaceProps } from 'talisman-cms/ui/lib/admin-sections';
import { ArrowRight, Boxes, CircleDollarSign, Gift, Mail, Package, Plus, ShoppingBag, Sparkles, Truck } from './icons';
import { extensionPathOf, groupCommerceModels, modelHelp, type CommerceModel as Model } from './workspace-models';

type Tool = AdminSectionWorkspaceProps['adminLinks'][number];
const toolIcons = new Map([['Needs attention', Sparkles], ['Email recovery', Mail], ['Stock overview', Boxes],
  ['Orders & fulfillment', Truck], ['Promotions & referrals', CircleDollarSign], ['Gift cards', Gift], ['Test checkout', ShoppingBag]]);
const count = (model?: Model) => model?.itemCount == null ? '—' : model.itemCount.toLocaleString();
function ToolLink({ tool, children, className }: { tool: Tool; children: React.ReactNode; className: string }) {
  const path = extensionPathOf(tool.href);
  return path ? <Link to={`/extensions/${path}`} className={className}>{children}</Link> : <a href={tool.href} className={className}>{children}</a>;
}
function ModelLink({ model, section }: { model: Model; section: string }) {
  return <Link to={`/${section}/${model.slug}`} className="group flex min-w-0 items-center gap-3 rounded-xl border border-white/10 px-4 py-3 hover:bg-white/5">
    <Boxes size={17} className="shrink-0 text-indigo-300" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-zinc-100">{model.name}</span><span className="mt-1 block text-xs text-zinc-500">{modelHelp(model)}</span></span><span className="text-xs tabular-nums text-zinc-400">{count(model)}</span>
  </Link>;
}
function Group({ title, models, section }: { title: string; models: Model[]; section: string }) {
  if (!models.length) return null;
  return <section><h3 className="mb-3 text-sm font-semibold text-white">{title}</h3><div className="space-y-2">{models.map(model => <ModelLink key={model.slug} model={model} section={section} />)}</div></section>;
}
export default function CommerceWorkspace({ section, collections: models, adminLinks: tools }: AdminSectionWorkspaceProps) {
  const { products, orders, discountCodes, giftCards, content, catalog, shoppers, promotions, giftRecords, advanced } = groupCommerceModels(models);
  const primaryLabels = ['Orders & fulfillment', 'Stock overview', 'Returns'];
  const primary = primaryLabels.flatMap(label => { const tool = tools.find(tool => tool.label === label); return tool ? [tool] : []; });
  const secondary = tools.filter(tool => !primary.includes(tool));
  const card = 'group flex min-w-0 flex-col rounded-2xl border border-white/10 bg-zinc-900/70 p-5 transition-colors hover:border-indigo-400/50 hover:bg-indigo-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400';
  const records = [...advanced, ...[orders, discountCodes, giftCards].filter((model): model is Model => Boolean(model))];
  return <div className="mx-auto max-w-7xl space-y-8 pb-10">
    <header className="flex flex-wrap items-center justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-300">Store workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{section.label}</h1><p className="mt-2 text-sm text-zinc-400">Your catalog, stock, and customer orders. Start with the work in front of you.</p></div>
      {products && <Link to={`/${section.id}/${products.slug}/new`} className="inline-flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-400"><Plus size={17} /> Add product</Link>}
    </header>
    <nav aria-label="Daily commerce workflows" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {products && <Link to={`/${section.id}/${products.slug}`} className={card}><Package size={20} className="text-indigo-300" /><span className="mt-4 text-lg font-semibold text-white">Products</span><span className="mt-1 text-xs leading-5 text-zinc-400">{count(products)} products · Images, pricing, and variants</span><ArrowRight size={17} className="mt-4 self-end text-indigo-300" /></Link>}
      {primary.map(tool => { const Icon = toolIcons.get(tool.label) ?? ShoppingBag; return <ToolLink key={tool.href} tool={tool} className={card}><Icon size={20} className="text-indigo-300" /><span className="mt-4 text-lg font-semibold text-white">{tool.label === 'Orders & fulfillment' ? 'Orders' : tool.label === 'Stock overview' ? 'Inventory' : tool.label}</span><span className="mt-1 text-xs leading-5 text-zinc-400">{tool.description}</span><ArrowRight size={17} className="mt-4 self-end text-indigo-300" /></ToolLink>; })}
    </nav>
    {secondary.length > 0 && <section aria-label="Store operations"><h2 className="mb-4 text-lg font-semibold text-white">Keep the store moving</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{secondary.map(tool => { const Icon = toolIcons.get(tool.label) ?? Boxes; return <ToolLink key={tool.href} tool={tool} className="flex min-w-0 items-start gap-3 rounded-xl border border-white/10 p-4 hover:border-indigo-400/40 hover:bg-white/5"><Icon size={18} className="mt-0.5 shrink-0 text-indigo-300" /><span><strong className="block text-sm font-semibold text-white">{tool.label}</strong><span className="mt-1 block text-xs leading-5 text-zinc-400">{tool.description}</span></span></ToolLink>; })}</div></section>}
    {content.length > 0 && <Group title="Store content" models={content} section={section.id} />}
    <details className="rounded-2xl border border-white/10 p-5"><summary className="cursor-pointer text-sm font-semibold text-zinc-200">Catalog setup and customer records</summary><p className="mt-2 text-xs text-zinc-400">Manage categories, shared parts, option definitions, and customer records. Edit a product’s own options from its product page.</p><div className="mt-5 grid gap-8 xl:grid-cols-2"><Group title="Catalog setup" models={catalog} section={section.id} /><Group title="Shoppers & carts" models={shoppers} section={section.id} /><Group title="Promotions & referrals" models={promotions} section={section.id} /><Group title="Gift card activity" models={giftRecords} section={section.id} /></div></details>
    {records.length > 0 && <details className="rounded-2xl border border-white/10 p-5"><summary className="cursor-pointer text-sm font-medium text-zinc-400">Data and audit records · {records.length} models</summary><p className="mt-2 text-xs text-zinc-500">Detailed records for support, accounting, and troubleshooting.</p><div className="mt-5 grid gap-2 md:grid-cols-2">{records.map(model => <ModelLink key={model.slug} model={model} section={section.id} />)}</div></details>}
  </div>;
}
