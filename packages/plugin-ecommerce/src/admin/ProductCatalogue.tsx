import React, { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { productsCollectionSlug } from "virtual:talisman-cms/ecommerce-admin";
import type {
  CatalogueFilters,
  CatalogueRow,
  readAdminCatalogue,
} from "@talisman-cms/plugin-ecommerce/operations";
import { adminRequest, errorText, money, storeCurrency } from "./common";
import { useOperationsRead } from "./operations-common";
import { useWarehouseWrite } from "./warehouse-write";
import ProductPriceInput from "./ProductPriceInput";
import { cataloguePrice, catalogueRange } from "./catalogue-price";
import "./commerce-admin.css";

type Result = Awaited<ReturnType<typeof readAdminCatalogue>>;
const valid = (v: unknown): v is Result =>
  !!v &&
  Array.isArray((v as Result).rows) &&
  Number.isFinite((v as Result).total) &&
  !!(v as Result).counts;
const defaults: CatalogueFilters = {
  search: "",
  status: "",
  category: "",
  attention: "all",
  threshold: 5,
  sort: "updated",
  page: 1,
};
const storageKey = `talisman:catalogue:${productsCollectionSlug}`;
function initialFilters(): CatalogueFilters {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (
      saved &&
      typeof saved.search === "string" &&
      saved.search.length <= 120 &&
      ["", "draft", "active", "archived"].includes(saved.status) &&
      typeof saved.category === "string" &&
      saved.category.length <= 128 &&
      ["name", "updated", "price-asc", "price-desc"].includes(saved.sort) &&
      [1, 3, 5, 10, 20].includes(saved.threshold) &&
      Number.isInteger(saved.page) &&
      saved.page > 0 &&
      saved.page <= 1000000 &&
      ["all", "images", "low", "out", "price"].includes(saved.attention)
    )
      return { ...defaults, ...saved };
  } catch {}
  return defaults;
}
const labels = {
  draft: "Draft",
  active: "Available in store",
  archived: "Archived",
};
function priceRange(min: number, max: number, currency: string) {
  return min === max
    ? money(min, currency)
    : `${money(min, currency)} – ${money(max, currency)}`;
}

function CatalogueBulk({
  ids,
  kind,
  close,
  refresh,
}: {
  ids: string[];
  kind: "price" | "visibility";
  close: () => void;
  refresh: () => Promise<unknown>;
}) {
  const [rows, setRows] = useState<CatalogueRow[] | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [complete, setComplete] = useState(false);
  const [mode, setMode] = useState<"set" | "increase" | "decrease">("set"),
    [amount, setAmount] = useState(""),
    [visibility, setVisibility] = useState("");
  const write = useWarehouseWrite(refresh, {
      draftLabel: "catalogue",
      reloadMessage:
        "Reload the selected products to review their latest prices and visibility.",
    }),
    region = useRef<HTMLElement>(null),
    inputId = useId(),
    currency = storeCurrency();
  const locked = write.busy || !!write.pending;
  const preview = (rows || []).map((row) => ({
    ...row,
    next: kind === "price" ? cataloguePrice(row.basePrice, mode, amount) : null,
  }));
  const ready =
    !!rows &&
    (kind === "price" ? preview.every((r) => r.next !== null) : !!visibility);
  const changedCount = preview.filter((r) =>
    kind === "price" ? r.next !== r.basePrice : visibility !== r.status,
  ).length;
  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await adminRequest<{ rows: CatalogueRow[] }>(
        "operations",
        { action: "catalogueSelection", data: { ids } },
      );
      if (!Array.isArray(response.rows) || response.rows.length !== ids.length)
        throw new Error(
          "Some products could not be loaded. Refresh your selection.",
        );
      setRows(response.rows);
      write.loaded();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView({ block: "nearest" });
    void load();
  }, []);
  return (
    <section
      className="ecom-catalogue-bulk"
      aria-label={
        kind === "price" ? "Review bulk prices" : "Review bulk visibility"
      }
      tabIndex={-1}
      ref={region}
    >
      <header>
        <div>
          <p className="ecom-catalogue-eyebrow">Review your changes</p>
          <h2>
            {kind === "price"
              ? "Update product prices"
              : "Update product visibility"}{" "}
            · {ids.length} selected
          </h2>
        </div>
        <button
          type="button"
          className="ecom-catalogue-secondary"
          disabled={locked}
          onClick={close}
        >
          {complete ? "Done" : "Cancel"}
        </button>
      </header>
      {write.feedback}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading current product details…</p>}
      {(error || write.needsReload) && (
        <button
          type="button"
          disabled={locked || loading}
          onClick={() => void load()}
        >
          Reload selected products
        </button>
      )}
      {!complete && rows && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (write.blocked() || !ready || !changedCount) return;
            void write.send(
              {
                path: "operations",
                body: {
                  action: "catalogueUpdate",
                  data: {
                    requestKey: crypto.randomUUID(),
                    collectionSlug: productsCollectionSlug,
                    kind,
                    rows: preview.map((r) => ({
                      id: r.id,
                      expectedUpdatedAt: r.updatedAt,
                      ...(kind === "price"
                        ? { basePrice: r.next }
                        : { status: visibility }),
                    })),
                  },
                },
                receipt: "batchId",
                success: `${kind === "price" ? "Prices" : "Visibility"} saved for ${changedCount} product${changedCount === 1 ? "" : "s"}.`,
              },
              () => setComplete(true),
            );
          }}
        >
          <fieldset disabled={locked || write.needsReload || loading}>
            {kind === "price" ? (
              <>
                <div className="ecom-catalogue-bulk-fields">
                  <label>
                    Price change
                    <select
                      aria-label="Price change"
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value as typeof mode);
                        setAmount("");
                        write.setDirty(true);
                      }}
                    >
                      <option value="set">Set the same base price</option>
                      <option value="increase">
                        Increase base prices by %
                      </option>
                      <option value="decrease">
                        Decrease base prices by %
                      </option>
                    </select>
                  </label>
                  <label htmlFor={inputId}>
                    {mode === "set"
                      ? `New base price (${currency.toUpperCase()})`
                      : "Percentage"}
                    {mode === "set" ? (
                      <ProductPriceInput
                        id={inputId}
                        value={amount}
                        onChange={(value) => {
                          setAmount(value);
                          write.setDirty(true);
                        }}
                      />
                    ) : (
                      <input
                        id={inputId}
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 10"
                        value={amount}
                        onChange={(e) => {
                          setAmount(e.target.value);
                          write.setDirty(true);
                        }}
                      />
                    )}
                  </label>
                </div>
                <p>
                  Base prices apply to variants that use the product price.{" "}
                  {rows.reduce((n, r) => n + r.customPrices, 0)} choices have
                  their own price and keep it.
                </p>
                {amount && !ready && (
                  <p role="alert">
                    Enter a positive price with valid currency decimals, or a
                    percentage that keeps every price above zero.
                  </p>
                )}
              </>
            ) : (
              <>
                <label>
                  New visibility
                  <select
                    aria-label="New visibility"
                    value={visibility}
                    onChange={(e) => {
                      setVisibility(e.target.value);
                      write.setDirty(true);
                    }}
                  >
                    <option value="">Choose visibility…</option>
                    <option value="active">Available in store</option>
                    <option value="draft">Draft — hidden from shoppers</option>
                    <option value="archived">
                      Archived — hidden from shoppers
                    </option>
                  </select>
                </label>
                <p>
                  {visibility === "active"
                    ? "These products will appear in the store. Shoppers can buy only the options with a price and available stock."
                    : visibility
                      ? "These products will be hidden from shoppers. Existing orders remain accessible."
                      : "Choose whether shoppers can see these products. Stock quantities are managed separately."}
                </p>
                {visibility === "active" &&
                  rows.some((r) => !r.image || !r.inStock) && (
                    <p className="ecom-catalogue-warning">
                      {rows.filter((r) => !r.image).length} without a product
                      image · {rows.filter((r) => !r.inStock).length} with no
                      purchasable choices. Review these products before making
                      them available.
                    </p>
                  )}
              </>
            )}
            <div
              className="ecom-catalogue-review"
              role="group"
              aria-label="Product changes to review"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>
                      Current {kind === "price" ? "base price" : "visibility"}
                    </th>
                    <th>After saving</th>
                    {kind === "price" && <th>Shopper prices after saving</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">
                        {r.name}
                        {r.customPrices > 0 && kind === "price" && (
                          <small>{r.customPrices} custom-priced choices</small>
                        )}
                      </th>
                      <td>
                        {kind === "price"
                          ? money(r.basePrice, currency)
                          : labels[r.status]}
                      </td>
                      <td>
                        {kind === "price"
                          ? r.next === null
                            ? "Enter a price"
                            : money(r.next, currency)
                          : visibility
                            ? labels[visibility as keyof typeof labels]
                            : "Choose visibility"}
                      </td>
                      {kind === "price" && (
                        <td>
                          {r.next === null
                            ? "—"
                            : (() => {
                                const range = catalogueRange(r, r.next!);
                                return priceRange(
                                  range.min,
                                  range.max,
                                  currency,
                                );
                              })()}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </fieldset>
          <footer>
            <span>
              {ready
                ? `${changedCount} product${changedCount === 1 ? "" : "s"} will change`
                : "Review every product before saving"}
            </span>
            <button
              type="submit"
              disabled={
                locked ||
                loading ||
                write.needsReload ||
                !ready ||
                !changedCount
              }
            >
              {write.busy
                ? "Saving…"
                : `Save ${kind === "price" ? "prices" : "visibility"} for ${changedCount} product${changedCount === 1 ? "" : "s"}`}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}

export default function ProductCatalogue({
  collection,
  section,
}: {
  collection: { name: string; readOnly?: boolean };
  section: string;
}) {
  const [filters, setFilters] = useState(initialFilters),
    [search, setSearch] = useState(filters.search),
    [selected, setSelected] = useState<Map<string, string>>(new Map()),
    [bulk, setBulk] = useState<"price" | "visibility" | null>(null);
  const query = new URLSearchParams({
    view: "catalogue",
    ...Object.fromEntries(
      Object.entries(filters).map(([key, value]) => [key, String(value)]),
    ),
  }).toString();
  const read = useOperationsRead<Result>(query, valid),
    data = read.data,
    currency = storeCurrency(),
    summary = useRef<HTMLParagraphElement>(null);
  const disabled = !!bulk || read.loading || !!read.error;
  const change = (patch: Partial<CatalogueFilters>) =>
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  useEffect(() => {
    if (bulk) return;
    const timer = setTimeout(() => {
      if (search !== filters.search) change({ search });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, filters.search, bulk]);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {}
  }, [filters]);
  const rows = data?.rows || [],
    allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id)),
    unionSize = new Set([...selected.keys(), ...rows.map((r) => r.id)]).size;
  const hidden = [...selected.keys()].filter(
    (id) => !rows.some((r) => r.id === id),
  ).length;
  const link = (id: string) => `/${section}/${productsCollectionSlug}/${id}`;
  const reset = () => {
    setSearch("");
    setFilters(defaults);
  };
  return (
    <div className="ecom-catalogue">
      <header className="ecom-catalogue-header">
        <div>
          <Link to={`/${section}`}>← Commerce</Link>
          <h1>Products</h1>
          <p>Find what needs attention. Keep your catalogue ready to shop.</p>
        </div>
        {!collection.readOnly && (
          <Link className="ecom-catalogue-primary" to={link("new")}>
            Add product
          </Link>
        )}
      </header>
      <fieldset className="ecom-catalogue-filters" disabled={!!bulk}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            change({ search });
          }}
        >
          <label>
            Find products
            <input
              aria-label="Find products"
              type="search"
              maxLength={120}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search product name, SKU or variant"
            />
          </label>
          <button type="submit" className="ecom-catalogue-secondary">
            Search
          </button>
        </form>
        <label>
          Visibility
          <select
            aria-label="Filter catalogue visibility"
            value={filters.status}
            onChange={(e) =>
              change({ status: e.target.value as CatalogueFilters["status"] })
            }
          >
            <option value="">All visibility</option>
            <option value="active">Available in store</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label>
          Category
          <select
            aria-label="Filter catalogue category"
            value={filters.category}
            onChange={(e) => change({ category: e.target.value })}
          >
            <option value="">All categories</option>
            {data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            aria-label="Sort catalogue"
            value={filters.sort}
            onChange={(e) =>
              change({ sort: e.target.value as CatalogueFilters["sort"] })
            }
          >
            <option value="updated">Recently updated</option>
            <option value="name">Product name</option>
            <option value="price-asc">Base price: low to high</option>
            <option value="price-desc">Base price: high to low</option>
          </select>
        </label>
      </fieldset>
      <div
        className="ecom-catalogue-attention"
        role="group"
        aria-label="Catalogue attention views"
      >
        {(
          [
            { key: "all", label: "All products" },
            { key: "images", label: "Missing images" },
            { key: "low", label: "Low stock" },
            { key: "out", label: "Sold-out choices" },
            { key: "price", label: "Missing prices" },
          ] as const
        ).map((view) => (
          <button
            key={view.key}
            type="button"
            aria-pressed={filters.attention === view.key}
            disabled={!!bulk || read.loading}
            onClick={() => change({ attention: view.key })}
          >
            <span>{view.label}</span>
            <strong>{data?.counts[view.key] ?? "—"}</strong>
          </button>
        ))}
      </div>
      <div className="ecom-catalogue-context">
        <p>
          {filters.search || filters.status || filters.category
            ? "Counts show products matching your search and filters."
            : "Counts show products across the whole catalogue."}{" "}
          Low stock means{" "}
          {filters.threshold === 1 ? "1 unit" : `1–${filters.threshold} units`}{" "}
          for a choice.
        </p>
        <label>
          Low-stock threshold
          <select
            aria-label="Low-stock threshold"
            value={filters.threshold}
            disabled={!!bulk}
            onChange={(e) => change({ threshold: Number(e.target.value) })}
          >
            {[1, 3, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "unit" : "units"}
              </option>
            ))}
          </select>
        </label>
        {(search ||
          filters.status ||
          filters.category ||
          filters.attention !== "all") && (
          <button
            type="button"
            className="ecom-catalogue-secondary"
            disabled={!!bulk}
            onClick={reset}
          >
            Clear filters
          </button>
        )}
        <button
          className="ecom-catalogue-secondary"
          disabled={!!bulk || read.loading}
          onClick={() => void read.load()}
        >
          Refresh catalogue
        </button>
      </div>
      {read.error && (
        <p role="alert">
          {read.error} Displayed products may be out of date. Refresh before
          making changes.
        </p>
      )}
      <div className="ecom-catalogue-selection">
        <label>
          <input
            type="checkbox"
            aria-label="Select this page"
            ref={(input) => {
              if (input)
                input.indeterminate =
                  !allSelected && rows.some((row) => selected.has(row.id));
            }}
            disabled={
              disabled || !rows.length || (!allSelected && unionSize > 50)
            }
            checked={allSelected}
            onChange={() => {
              const next = new Map(selected);
              for (const r of rows)
                allSelected ? next.delete(r.id) : next.set(r.id, r.name);
              setSelected(next);
            }}
          />
          Select this page
        </label>
        <strong>
          {selected.size} selected
          {hidden ? ` · ${hidden} on other pages or hidden by filters` : ""}
        </strong>
        {selected.size > 0 && (
          <>
            <button
              type="button"
              className="ecom-catalogue-secondary"
              disabled={!!bulk}
              onClick={() => setSelected(new Map())}
            >
              Clear selection
            </button>
            <button
              type="button"
              disabled={disabled || collection.readOnly}
              onClick={() => setBulk("price")}
            >
              Update prices
            </button>
            <button
              type="button"
              disabled={disabled || collection.readOnly}
              onClick={() => setBulk("visibility")}
            >
              Update visibility
            </button>
          </>
        )}
        <small>Select up to 50 products across pages.</small>
      </div>
      {bulk && (
        <CatalogueBulk
          ids={[...selected.keys()]}
          kind={bulk}
          refresh={read.load}
          close={() => {
            setBulk(null);
            requestAnimationFrame(() => summary.current?.focus());
          }}
        />
      )}
      <p
        ref={summary}
        tabIndex={-1}
        role="status"
        className="ecom-catalogue-results"
      >
        {read.loading
          ? "Loading products…"
          : data
            ? `${data.total} product${data.total === 1 ? "" : "s"} · Page ${data.page} of ${data.pages}`
            : "Products unavailable"}
      </p>
      <div
        inert={!!bulk}
        aria-busy={read.loading}
        className="ecom-catalogue-list"
      >
        {!read.loading && !read.error && !rows.length && (
          <div className="ecom-catalogue-empty">
            <h2>
              {filters.attention === "all"
                ? "No products match"
                : "No products need this attention"}
            </h2>
            <p>Try a different search or return to all products.</p>
            <button type="button" onClick={reset}>
              Clear all filters
            </button>
          </div>
        )}
        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select</span>
                </th>
                <th>Product</th>
                <th>Price</th>
                <th>Stock & choices</th>
                <th>Visibility</th>
                <th>Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-selected={selected.has(row.id)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      disabled={
                        disabled ||
                        (!selected.has(row.id) && selected.size >= 50)
                      }
                      checked={selected.has(row.id)}
                      onChange={() => {
                        const next = new Map(selected);
                        next.has(row.id)
                          ? next.delete(row.id)
                          : next.set(row.id, row.name);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <th scope="row">
                    <Link to={link(row.id)} className="ecom-catalogue-product">
                      {row.image ? (
                        <img src={row.image} alt="" loading="lazy" />
                      ) : (
                        <span
                          className="ecom-catalogue-no-image"
                          aria-hidden="true"
                        >
                          ＋
                        </span>
                      )}
                      <span>
                        <strong>{row.name}</strong>
                        <small>{row.sku || "No product SKU"}</small>
                      </span>
                    </Link>
                  </th>
                  <td data-label="Price">
                    <strong>{money(row.basePrice, currency)}</strong>
                    <small>Base price</small>
                    {row.customPrices > 0 && (
                      <small>
                        Choices{" "}
                        {priceRange(row.minPrice, row.maxPrice, currency)}
                      </small>
                    )}
                  </td>
                  <td data-label="Stock">
                    <Link to={link(row.id)} hash="commerce-product-options">
                      {row.type !== "standard"
                        ? "Stock not tracked"
                        : row.variantCount
                          ? `${row.inStock} of ${row.choiceCount} choices available`
                          : `${row.simpleQuantity} available`}
                      <small>
                        {row.variantCount
                          ? `${row.variantCount} variants`
                          : row.type === "standard"
                            ? "Single product"
                            : row.type === "digital"
                              ? "Digital download"
                              : "Subscription"}
                      </small>
                    </Link>
                  </td>
                  <td data-label="Visibility">
                    <span
                      className={`ecom-catalogue-status ecom-catalogue-status--${row.status}`}
                    >
                      {labels[row.status]}
                    </span>
                  </td>
                  <td data-label="Attention">
                    <div className="ecom-catalogue-flags">
                      {!row.image && (
                        <Link to={link(row.id)} hash="entry-fields">
                          Add an image
                        </Link>
                      )}
                      {row.lowCount > 0 && (
                        <Link to={link(row.id)} hash="commerce-product-options">
                          {row.lowCount} low-stock{" "}
                          {row.variantCount
                            ? row.lowCount === 1
                              ? "choice"
                              : "choices"
                            : "product"}
                        </Link>
                      )}
                      {row.outCount > 0 && (
                        <Link to={link(row.id)} hash="commerce-product-options">
                          {row.outCount} sold out
                        </Link>
                      )}
                      {row.missingPrice > 0 && (
                        <Link to={link(row.id)}>
                          Add {row.missingPrice > 1 ? "prices" : "a price"}
                        </Link>
                      )}
                      {row.image &&
                        !row.lowCount &&
                        !row.outCount &&
                        !row.missingPrice && (
                          <span className="ecom-catalogue-ready">Ready</span>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && (
        <nav aria-label="Catalogue pages" className="ecom-catalogue-pagination">
          <button
            type="button"
            className="ecom-catalogue-secondary"
            disabled={disabled || data.page <= 1}
            onClick={() => {
              change({ page: data.page - 1 });
              summary.current?.focus();
            }}
          >
            Previous page
          </button>
          <span>
            {data.total
              ? `${(data.page - 1) * 25 + 1}–${Math.min(data.page * 25, data.total)} of ${data.total}`
              : "0 products"}
          </span>
          <button
            type="button"
            className="ecom-catalogue-secondary"
            disabled={disabled || data.page >= data.pages}
            onClick={() => {
              change({ page: data.page + 1 });
              summary.current?.focus();
            }}
          >
            Next page
          </button>
        </nav>
      )}
    </div>
  );
}
