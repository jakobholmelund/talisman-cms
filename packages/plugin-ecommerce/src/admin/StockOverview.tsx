import Stocktakes from './Stocktakes';
import StockMovements from './StockMovements';
import React, { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { collections } from 'virtual:talisman-cms/config';
import { productsCollectionSlug } from 'virtual:talisman-cms/ecommerce-admin';
import type { readStockOverview } from '@talisman-cms/plugin-ecommerce/operations';
import { CommerceAdmin, Field, Panel } from './common';
import { OperationsPagination, OperationsReadStatus, useOperationsRead } from './operations-common';
import { stockTarget, type StockTarget } from './stock-target';

type Snapshot = Awaited<ReturnType<typeof readStockOverview>>;
const validSnapshot = (value: unknown): value is Snapshot => !!value && typeof value === 'object'
  && Array.isArray((value as Snapshot).rows) && Number.isFinite((value as Snapshot).total);
export default function StockOverview() {
  const [filters, setFilters] = useState({ inventory: 'choices', threshold: '5', filter: 'low', search: '', offset: '0' });
  const [draft, setDraft] = useState(filters);
  const [target, setTarget] = useState<(StockTarget & { selection: number }) | undefined>();
  const [stockDirty, setStockDirty] = useState(false), [countsOpened, setCountsOpened] = useState(false);
  const hash = useLocation({ select: location => location.hash });
  useEffect(() => { const selected = stockTarget(hash); if (selected) setTarget({ ...selected, selection: Date.now() }); }, [hash]);
  const { data, loading, error, load } = useOperationsRead<Snapshot>(new URLSearchParams({ view: 'stock', ...filters }).toString(), validSnapshot);
  const products = collections.find(collection => collection.slug === productsCollectionSlug);
  const parts = collections.find(collection => collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema' && collection.nativeSchemaMapping.exportName === 'components');
  const apply = (next: typeof filters) => { setDraft(next); setFilters(next); };
  return <CommerceAdmin current="stock"><p className="ecom-admin__intro">Find what needs replenishing, receive deliveries, and follow every stock change. Quantities already account for checkout reservations.</p>
    <div className="ecom-admin__views" role="group" aria-label="Inventory views">{[['low','Low stock'],['unavailable','Out of stock'],['all','All inventory']].map(([key,label]) => <button key={key} type="button" aria-pressed={filters.filter === key} onClick={() => apply({ ...filters, filter: key, offset: '0' })}>{label}</button>)}</div>
    <Panel title="Find stock" label="Stock filters"><form onSubmit={event => { event.preventDefault(); apply({ ...draft, offset: '0' }); }}>
      <div className="ecom-admin__fields ecom-admin__stock-filters">
        <Field label="Name or SKU"><input type="search" name="search" maxLength={100} value={draft.search} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} placeholder="Search products, options, or parts" /></Field>
        <Field label="Inventory"><select aria-label="Inventory" name="inventory" value={draft.inventory} onChange={event => setDraft(current => ({ ...current, inventory: event.target.value }))}><option value="choices">Sellable choices</option><option value="components">Shared components</option></select></Field>
        <Field label="Show"><select aria-label="Show" name="filter" value={draft.filter} onChange={event => setDraft(current => ({ ...current, filter: event.target.value }))}><option value="low">Low stock</option><option value="unavailable">Unavailable</option><option value="all">All stock</option></select></Field>
        <Field label="Low stock threshold"><input name="threshold" type="number" min="0" max="1000000" step="1" value={draft.threshold} onChange={event => setDraft(current => ({ ...current, threshold: event.target.value }))} required /></Field>
      </div><div className="ecom-admin__actions"><button type="submit" disabled={loading}>Apply filters</button>{filters.search && <button type="button" className="ecom-admin__secondary" onClick={() => apply({ ...filters, search: '', offset: '0' })}>Clear search</button>}</div>
    </form></Panel>
    <OperationsReadStatus loading={loading} error={error} reload={() => void load()} />
    {data && <Panel title={data.view === 'components' ? 'Shared component stock' : 'Sellable choice stock'} label="Stock results">
      <p className="ecom-admin__muted">{data.total} matching {data.total === 1 ? 'record' : 'records'}. Choose an item to receive stock or make a correction.</p>
      {!data.rows.length ? <div className="ecom-admin__empty"><h3>{filters.filter === 'low' && !filters.search ? 'Stock is looking healthy' : 'No stock matches these filters'}</h3><p>Try all inventory or change your search to find an item.</p><button type="button" className="ecom-admin__secondary" onClick={() => apply({ ...filters, filter: 'all', search: '', offset: '0' })}>View all inventory</button></div> : <div className="ecom-admin__table-wrap"><table><thead><tr><th>Item</th><th>Available</th><th>Stock source</th><th>Actions</th></tr></thead><tbody>{data.rows.map(row => {
        const model = row.kind === 'component' ? parts : products, id = row.productId ?? row.id;
        return <tr key={`${row.kind}:${row.id}`}><td><strong>{row.name}</strong><small className="ecom-admin__stock-sku">{row.sku || 'No SKU'}</small></td><td><span className="ecom-admin__badge" data-tone={row.quantity <= data.threshold ? 'warning' : 'success'}>{row.quantity === 0 ? 'Out of stock' : `${row.quantity} units`}</span></td><td>{row.source}</td><td><div className="ecom-admin__row-actions">
          {row.targetType && row.targetId ? <button type="button" className="ecom-admin__secondary" aria-label={`Adjust stock · ${row.name}`} disabled={stockDirty || loading || !!error} onClick={() => setTarget({ type: row.targetType!, id: row.targetId!, selection: Date.now() })}>Adjust stock</button> : <button type="button" className="ecom-admin__secondary" onClick={() => apply({ ...filters, inventory: 'components', filter: 'all', search: '', offset: '0' })}>View shared parts</button>}
          {model && !model.readOnly && <Link to={`/${model.adminSection || 'commerce'}/${model.slug}/${id}`}>View {row.kind === 'component' ? 'component' : 'product'}</Link>}
        </div></td></tr>;
      })}</tbody></table></div>}
      <OperationsPagination offset={data.offset} total={data.total} loading={loading} change={offset => setFilters(current => ({ ...current, offset: String(offset) }))} />
      <details className="ecom-admin__muted"><summary>How shared-component stock works</summary><p>Each choice shows the maximum units its parts can make. Choices sharing a part draw from the same supply; their quantities cannot be added together.</p></details>
    </Panel>}
    <StockMovements refreshOverview={load} target={target} draftChanged={setStockDirty} />
    <details className="ecom-admin__tool-disclosure" onToggle={event => { if (event.currentTarget.open) setCountsOpened(true); }}><summary>Count & reconcile inventory</summary><p className="ecom-admin__muted">Compare a physical count with the recorded stock, review differences, and save an audited correction.</p>{countsOpened && <Stocktakes refreshOverview={load} />}</details>
  </CommerceAdmin>;
}
