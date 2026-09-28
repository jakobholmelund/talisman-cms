import React from 'react';
import { Link } from '@tanstack/react-router';
import type { AdminSectionWorkspaceProps } from 'talisman-cms/ui/lib/admin-sections';
import { ArrowRight, Boxes, CircleDollarSign, Gift, Package, Plus, ShoppingBag, Sparkles, Truck } from './icons';

// The Commerce section's index page (AdminSectionDefinition.componentPath): the store's models in
// groups, the plugin tools registered as adminLinks, and the highlights with their record counts.

type Model = AdminSectionWorkspaceProps['collections'][number];
type Tool = AdminSectionWorkspaceProps['adminLinks'][number];

const catalogSlugs = new Set([
  '_ecommerce_categories', '_ecommerce_tags', '_ecommerce_variants',
  '_ecommerce_product_variants', '_ecommerce_product_variant_values',
  '_ecommerce_stocks', '_ecommerce_components', '_ecommerce_variant_components'
]);
const shopperSlugs = new Set(['_ecommerce_customers', '_ecommerce_customer_accounts', '_ecommerce_carts']);
const promotionSlugs = new Set([
  '_ecommerce_referral_codes', '_ecommerce_referrals', '_ecommerce_referral_settings',
  '_ecommerce_discount_redemptions', '_ecommerce_credit_ledger'
]);
const giftSlugs = new Set([
  '_ecommerce_gift_card_purchases', '_ecommerce_gift_card_ledger',
  '_ecommerce_gift_card_redemptions', '_ecommerce_gift_card_refunds',
  '_ecommerce_gift_card_order_refunds', '_ecommerce_gift_card_reviews'
]);
const featuredSlugs = new Set(['products', '_ecommerce_orders', '_ecommerce_discount_codes', '_ecommerce_gift_cards']);

const help: Record<string, string> = {
  products: 'Images, prices, options, and availability',
  _ecommerce_orders: 'Payments and fulfillment',
  _ecommerce_discount_codes: 'Offers and promotional credit',
  _ecommerce_gift_cards: 'Issued cards and balances',
  _ecommerce_categories: 'Organize what shoppers browse',
  _ecommerce_product_variant_values: 'Shopper choices, images, and prices',
  _ecommerce_stocks: 'Stock available for each option',
  _ecommerce_components: 'Shared physical parts and supplies'
};

function count(model?: Model) { return model?.itemCount == null ? '—' : model.itemCount.toLocaleString(); }

/** The extension path an admin link points at, when it links to a plugin admin page. */
function extensionPathOf(href: string) {
  return /^\/(?:[^/?#]+\/)*extensions\/([^/?#]+)$/.exec(href)?.[1];
}

function ModelLink({ model, section }: { model: Model; section: string }) {
  return <Link to={`/${section}/${model.slug}`} className="group flex min-w-0 items-center gap-4 rounded-xl border border-white/10 bg-white/[0.025] px-4 py-4 transition-colors hover:border-indigo-400/40 hover:bg-indigo-400/[0.07]">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-indigo-300"><Boxes size={18} /></span>
    <span className="min-w-0 flex-1"><span className="block truncate font-medium text-zinc-100">{model.name}</span><span className="mt-0.5 block truncate text-xs text-zinc-500">{help[model.slug] || model.description || 'Manage records'}</span></span>
    <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs tabular-nums text-zinc-300">{count(model)}</span>
    <ArrowRight size={15} className="shrink-0 text-zinc-600 group-hover:text-indigo-300" />
  </Link>;
}

function Group({ title, description, models, section }: { title: string; description: string; models: Model[]; section: string }) {
  if (!models.length) return null;
  return <section><h2 className="text-xl font-semibold text-white">{title}</h2><p className="mb-4 mt-1 text-sm text-zinc-400">{description}</p><div className="space-y-2">{models.map(model => <ModelLink key={model.slug} model={model} section={section} />)}</div></section>;
}

export default function CommerceWorkspace({ section, collections: models, adminLinks: tools }: AdminSectionWorkspaceProps) {
  const sectionId = section.id;
  const bySlug = new Map(models.map(model => [model.slug, model]));
  const products = models.find(model => model.nativeSchemaMapping?.exportName === 'products') || bySlug.get('products');
  const content = models.filter(model => !model.slug.startsWith('_ecommerce_') && model.slug !== products?.slug);
  const catalog = models.filter(model => catalogSlugs.has(model.slug));
  const shoppers = models.filter(model => shopperSlugs.has(model.slug));
  const promotions = models.filter(model => promotionSlugs.has(model.slug));
  const giftRecords = models.filter(model => giftSlugs.has(model.slug));
  const advanced = models.filter(model => model.slug !== products?.slug && !featuredSlugs.has(model.slug) && !catalogSlugs.has(model.slug) && !shopperSlugs.has(model.slug) && !promotionSlugs.has(model.slug) && !giftSlugs.has(model.slug) && !content.includes(model));
  const highlights = [
    { model: products, label: 'Products', icon: Package },
    { model: bySlug.get('_ecommerce_orders'), label: 'Orders', icon: ShoppingBag },
    { model: bySlug.get('_ecommerce_discount_codes'), label: 'Discount codes', icon: CircleDollarSign },
    { model: bySlug.get('_ecommerce_gift_cards'), label: 'Gift cards', icon: Gift }
  ].filter(item => item.model);

  return <div className="mx-auto max-w-7xl space-y-10 pb-10">
    <section className="relative overflow-hidden rounded-3xl border border-indigo-400/20 bg-gradient-to-br from-indigo-950/80 via-zinc-900 to-zinc-950 px-7 py-8 sm:px-10 sm:py-10">
      <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-indigo-500/15 blur-3xl" />
      <div className="relative flex flex-wrap items-end justify-between gap-8">
        <div className="max-w-xl"><span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-300"><Sparkles size={13} /> Store workspace</span><h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">{section.label}</h1><p className="mt-4 text-sm leading-7 text-zinc-300">Run your catalog, look after shoppers, and keep orders moving from one place.</p></div>
        {products && <Link to={`/${sectionId}/${products.slug}/new`} className="inline-flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-400"><Plus size={17} /> Add product</Link>}
      </div>
      <div className="relative mt-9 grid gap-3 border-t border-white/10 pt-6 sm:grid-cols-2 lg:grid-cols-4">
        {highlights.map(item => <Link key={item.label} to={`/${sectionId}/${item.model!.slug}`} className="group rounded-xl border border-white/10 bg-white/[0.045] p-4 hover:bg-white/[0.09]"><div className="flex items-center justify-between text-zinc-400"><item.icon size={17} /><ArrowRight size={15} className="opacity-0 group-hover:opacity-100" /></div><div className="mt-4 text-3xl font-semibold tabular-nums text-white">{count(item.model)}</div><div className="mt-1 text-xs text-zinc-400">{item.label}</div></Link>)}
      </div>
    </section>
    {tools.length > 0 && <section><h2 className="text-xl font-semibold text-white">Get things done</h2><p className="mb-4 mt-1 text-sm text-zinc-400">Dedicated screens for everyday store work.</p><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{tools.map((tool: Tool, index: number) => {
      const Icon = [Truck, CircleDollarSign, Gift, ShoppingBag][index % 4];
      const extensionPath = extensionPathOf(tool.href);
      const className = 'group flex min-h-40 flex-col rounded-2xl border border-white/10 bg-zinc-900/60 p-5 hover:border-indigo-400/40 hover:bg-indigo-500/[0.08]';
      const content = <><Icon size={20} className="text-indigo-300" /><strong className="mt-5 text-sm font-semibold text-white">{tool.label}</strong><span className="mt-1 text-xs leading-5 text-zinc-400">{tool.description}</span><ArrowRight size={16} className="mt-auto self-end text-zinc-500 group-hover:text-indigo-300" /></>;
      return extensionPath
        ? <Link key={tool.href} to={`/extensions/${extensionPath}`} className={className}>{content}</Link>
        : <a key={tool.href} href={tool.href} className={className}>{content}</a>;
    })}</div></section>}
    <div className="grid gap-8 xl:grid-cols-2"><Group title="Store content" description="Stories and details around your products." models={content} section={sectionId} /><Group title="Catalog setup" description="Options, categories, stock, and components." models={catalog} section={sectionId} /><Group title="Shoppers & carts" description="Customer accounts and baskets." models={shoppers} section={sectionId} /><Group title="Promotions & referrals" description="Referral activity, discount use, and store credit." models={promotions} section={sectionId} /><Group title="Gift card activity" description="Purchases, redemptions, and refunds." models={giftRecords} section={sectionId} /></div>
    {advanced.length > 0 && <details className="rounded-2xl border border-white/10 bg-zinc-950/40 p-5"><summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-zinc-300">Data and audit records <span className="text-xs font-normal text-zinc-500">{advanced.length} models · Show all</span></summary><p className="mt-2 text-xs text-zinc-500">Advanced records for support, accounting, and troubleshooting.</p><div className="mt-5 grid gap-2 md:grid-cols-2">{advanced.map(model => <ModelLink key={model.slug} model={model} section={sectionId} />)}</div></details>}
  </div>;
}
