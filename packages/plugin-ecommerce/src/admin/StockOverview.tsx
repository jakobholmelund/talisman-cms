import React, { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { collections } from 'virtual:talisman-cms/config';
import { productsCollectionSlug } from 'virtual:talisman-cms/ecommerce-admin';
import type { readStockOverview } from '@talisman-cms/plugin-ecommerce/operations';
import { CommerceAdmin, Field, Panel } from './common';
import { OperationsPagination, OperationsReadStatus, useOperationsRead } from './operations-common';

type Snapshot = Awaited<ReturnType<typeof readStockOverview>>;
const validSnapshot = (value: unknown): value is Snapshot => !!value && typeof value === 'object'
  && Array.isArray((value as Snapshot).rows) && Number.isFinite((value as Snapshot).total);
export default function StockOverview() {
  const [filters, setFilters] = useState({ inventory: 'choices', threshold: '5', filter: 'low', search: '', offset: '0' });
  const { data, loading, error, load } = useOperationsRead<Snapshot>(new URLSearchParams({ view: 'stock', ...filters }).toString(), validSnapshot);
  const products = collections.find(collection => collection.slug === productsCollectionSlug);
  const parts = collections.find(collection => collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema'
    && collection.nativeSchemaMapping.exportName === 'components');
  return <CommerceAdmin current="stock"><p className="ecom-admin__intro">Available units after checkout reservations. Active stock-managed products only; shared components also appear in their own view.</p>
    <Panel title="Find stock" label="Stock filters"><form onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      setFilters({ inventory: String(form.get('inventory')), threshold: String(form.get('threshold')),
        filter: String(form.get('filter')), search: String(form.get('search')), offset: '0' });
    }}><div className="ecom-admin__fields ecom-admin__grid">
      <Field label="Inventory"><select aria-label="Inventory" name="inventory" defaultValue="choices"><option value="choices">Sellable choices</option><option value="components">Shared components</option></select></Field>
      <Field label="Show"><select aria-label="Show" name="filter" defaultValue="low"><option value="low">Low stock</option><option value="unavailable">Unavailable</option><option value="all">All stock</option></select></Field>
      <Field label="Low stock threshold"><input name="threshold" type="number" min="0" max="1000000" step="1" defaultValue="5" required /></Field>
      <Field label="Name or SKU"><input name="search" maxLength={100} /></Field>
    </div><div className="ecom-admin__actions"><button type="submit" disabled={loading}>Apply filters</button></div></form></Panel>
    <OperationsReadStatus loading={loading} error={error} reload={() => void load()} />
    {data && <Panel title={data.view === 'components' ? 'Shared component stock' : 'Sellable choice stock'} label="Stock results">
      <p>A choice using shared components shows the maximum units those parts can make. Choices sharing a part draw from the same supply; their quantities cannot be added together.</p>
      {!data.rows.length ? <p>No stock matches these filters.</p> : <div className="ecom-admin__table-wrap"><table><thead><tr><th>Item</th><th>SKU</th><th>Available</th><th>Stock source</th><th>Adjust stock</th></tr></thead><tbody>{data.rows.map(row => {
        const model = row.kind === 'component' ? parts : products;
        const id = row.productId ?? row.id;
        return <tr key={`${row.kind}:${row.id}`}><td>{row.name}</td><td>{row.sku || '—'}</td><td>{row.quantity === 0 ? 'Unavailable (0)' : row.quantity}</td><td>{row.source}</td><td>{model && !model.readOnly
          ? <Link to={`/${model.adminSection || 'commerce'}/${model.slug}/${id}`}>Edit {row.kind === 'component' ? 'component' : 'product'}</Link>
          : 'Use the store’s stock editor'}</td></tr>;
      })}</tbody></table></div>}
      <OperationsPagination offset={data.offset} total={data.total} loading={loading} change={offset => setFilters(current => ({ ...current, offset: String(offset) }))} />
    </Panel>}
  </CommerceAdmin>;
}
