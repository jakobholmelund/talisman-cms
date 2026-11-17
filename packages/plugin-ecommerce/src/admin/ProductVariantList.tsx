import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { MediaFieldInput } from "talisman-cms/ui/components/MediaFieldInput";
import { adminRequest, errorText } from "./common";
import { useWarehouseWrite } from "./warehouse-write";
import { variantAxes, type ExistingOptionSet } from "./variant-options";
import ProductChoiceSetup from "./ProductChoiceSetup";

type Variant = {
  localId: string;
  id: string | null;
  value: string;
  sku: string;
  image: string;
  stockId: string | null;
  updatedAt: string | number | null;
  quantity: number | null;
  stockSource: string;
};
type Snapshot = {
  type: string;
  id: string;
  quantity: number;
  updatedAt: string;
};
type BulkProps = {
  mode: "images" | "stock";
  values: Variant[];
  groupId: string;
  images: string[];
  basePath: string;
  refresh: () => Promise<void>;
  changed: (dirty: boolean) => void;
  close: () => void;
};
function BulkVariantEditor({
  mode,
  values,
  groupId,
  images,
  basePath,
  refresh,
  changed,
  close,
}: BulkProps) {
  const [image, setImage] = useState<string | null>(null),
    [chosen, setChosen] = useState(false),
    [complete, setComplete] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot[] | null>(null),
    [loading, setLoading] = useState(mode === "stock"),
    [error, setError] = useState("");
  const [kind, setKind] = useState("add"),
    [amounts, setAmounts] = useState<Record<string, string>>({}),
    [all, setAll] = useState(""),
    [reason, setReason] = useState("");
  const region = useRef<HTMLElement>(null),
    write = useWarehouseWrite(refresh, { navigationGuard: false });
  const locked = write.busy || !!write.pending;
  useEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => {
    changed(write.dirty || locked);
    return () => changed(false);
  }, [write.dirty, locked, changed]);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await adminRequest<{ rows: Snapshot[] }>("operations", {
        action: "stocktakeRead",
        data: {
          targets: values.map((v) => ({
            targetType: "stock",
            targetId: v.stockId,
          })),
        },
      });
      if (
        !Array.isArray(response.rows) ||
        values.some(
          (v) =>
            !response.rows.some(
              (row) =>
                row.type === "stock" &&
                row.id === v.stockId &&
                typeof row.quantity === "number" &&
                typeof row.updatedAt === "string",
            ),
        )
      )
        throw new Error(
          "Some stock could not be loaded. Refresh the variants before continuing.",
        );
      setSnapshot(response.rows);
      write.loaded();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (mode === "stock") void load();
  }, []);
  const after = (v: Variant) => {
    const current =
      snapshot?.find((row) => row.id === v.stockId)?.quantity ?? 0;
    return amounts[v.id!] === undefined || amounts[v.id!] === ""
      ? current
      : kind === "add"
        ? current + Number(amounts[v.id!])
        : Number(amounts[v.id!]);
  };
  const valid =
    !!snapshot &&
    values.every((v) => {
      const text = amounts[v.id!] ?? "";
      return (
        (text === "" || /^\d+$/.test(text)) &&
        Number.isSafeInteger(after(v)) &&
        after(v) >= 0 &&
        after(v) <= 1000000
      );
    });
  const altered = values.filter(
    (v) => after(v) !== snapshot?.find((row) => row.id === v.stockId)?.quantity,
  ).length;
  return (
    <section
      ref={region}
      tabIndex={-1}
      className="ecom-admin ecom-variant-bulk"
      aria-label={
        mode === "images"
          ? "Change selected variant images"
          : "Update selected variant stock"
      }
    >
      <header>
        <h4>
          {mode === "images" ? "Change images" : "Update stock"} ·{" "}
          {values.length} selected variants
        </h4>
        <button type="button" disabled={locked} onClick={close}>
          {complete ? "Done" : "Cancel"}
        </button>
      </header>
      {write.feedback}
      {error && <p role="alert">{error}</p>}
      {write.needsReload && (
        <button
          type="button"
          disabled={locked}
          onClick={() =>
            void refresh()
              .then(close)
              .catch((cause) => setError(errorText(cause)))
          }
        >
          Reload variants and review again
        </button>
      )}
      {loading && <p role="status">Loading current stock…</p>}
      {mode === "stock" && error && !snapshot && (
        <button type="button" onClick={() => void load()}>
          Retry loading stock
        </button>
      )}
      {!complete && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (write.blocked()) return;
            if (mode === "images") {
              if (!chosen) return;
              void write.send(
                {
                  path: "variants",
                  body: {
                    action: "setVariantImages",
                    groupId,
                    image,
                    values: values.map((v) => ({
                      id: v.id,
                      expectedUpdatedAt: v.updatedAt,
                    })),
                  },
                  receipt: "groupId",
                  success: `Image updated for ${values.length} variants.`,
                },
                () => setComplete(true),
              );
            } else {
              if (!valid || !altered || reason.trim().length < 8) return;
              void write.send(
                {
                  path: "operations",
                  body: {
                    action: "stocktake",
                    data: {
                      requestKey: crypto.randomUUID(),
                      reason: reason.trim(),
                      lines: values.map((v) => {
                        const row = snapshot!.find((r) => r.id === v.stockId)!;
                        return {
                          targetType: "stock",
                          targetId: row.id,
                          expectedQuantity: row.quantity,
                          expectedUpdatedAt: row.updatedAt,
                          countedQuantity: after(v),
                        };
                      }),
                    },
                  },
                  receipt: "stocktakeId",
                  success: `Stock updated for ${altered} variant${altered === 1 ? "" : "s"} with staff history.`,
                },
                () => setComplete(true),
              );
            }
          }}
        >
          <fieldset disabled={locked || write.needsReload || loading}>
            {mode === "images" ? (
              <>
                <p>
                  Choose one image for these variants. Their prices, SKUs and
                  stock stay as they are.
                </p>
                <div
                  className="ecom-variant-photo-picker"
                  role="group"
                  aria-label="Image for selected variants"
                >
                  <button
                    type="button"
                    aria-pressed={chosen && image === null}
                    onClick={() => {
                      setChosen(true);
                      setImage(null);
                      write.setDirty(true);
                    }}
                  >
                    Use product main image
                  </button>
                  {images.map((url, index) => (
                    <button
                      key={`${url}-${index}`}
                      type="button"
                      aria-label={`Use product image ${index + 1} for selected variants`}
                      aria-pressed={chosen && image === url}
                      onClick={() => {
                        setChosen(true);
                        setImage(url);
                        write.setDirty(true);
                      }}
                    >
                      <img src={url} alt="" />
                    </button>
                  ))}
                </div>
                <MediaFieldInput
                  pickerOnly
                  showPreview={false}
                  label="Image for selected variants"
                  adminBasePath={basePath}
                  value={image || ""}
                  onChange={(url) => {
                    setImage(url || null);
                    setChosen(true);
                    write.setDirty(true);
                  }}
                />
                <div
                  className="ecom-variant-image-review"
                  role="group"
                  aria-label="Image changes to review"
                  tabIndex={0}
                >
                  {values.map((v) => (
                    <div key={v.id}>
                      <span>{v.value}</span>
                      {(v.image || images[0]) && (
                        <img
                          src={v.image || images[0]}
                          alt={`Current image for ${v.value}`}
                        />
                      )}
                      <span aria-hidden="true">→</span>
                      {chosen && (image || images[0]) ? (
                        <img
                          src={image || images[0]}
                          alt={`New image for ${v.value}`}
                        />
                      ) : (
                        <span>
                          {chosen ? "Product main image" : "Choose an image"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              snapshot && (
                <>
                  <div className="ecom-variant-stock-controls">
                    <label>
                      Stock update
                      <select
                        aria-label="Stock update"
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value);
                          setAmounts({});
                          setAll("");
                          write.setDirty(true);
                        }}
                      >
                        <option value="add">Add units to current stock</option>
                        <option value="count">Set counted quantities</option>
                      </select>
                    </label>
                    <label>
                      Apply quantity to all
                      <input
                        aria-label="Apply quantity to all"
                        type="number"
                        min="0"
                        max="1000000"
                        step="1"
                        value={all}
                        onChange={(e) => setAll(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!/^\d+$/.test(all) || Number(all) > 1000000}
                      onClick={() => {
                        setAmounts(
                          Object.fromEntries(values.map((v) => [v.id!, all])),
                        );
                        write.setDirty(true);
                      }}
                    >
                      Apply to selected
                    </button>
                  </div>
                  <p>
                    {kind === "add"
                      ? "Enter units to add. Blank rows keep their current stock."
                      : "Enter the quantities you counted. Blank rows keep their current stock."}
                  </p>
                  <div
                    className="ecom-variant-stock-grid"
                    role="group"
                    aria-label="Stock changes to review"
                    tabIndex={0}
                  >
                    <div aria-hidden="true">
                      <strong>Variant</strong>
                      <span>Current</span>
                      <span>{kind === "add" ? "Add" : "Counted"}</span>
                      <span>After</span>
                    </div>
                    {values.map((v) => (
                      <label key={v.id}>
                        <span>{v.value}</span>
                        <span>
                          {snapshot.find((r) => r.id === v.stockId)?.quantity}
                        </span>
                        <input
                          aria-label={`${kind === "add" ? "Add units for" : "Counted stock for"} ${v.value}`}
                          type="number"
                          min="0"
                          max="1000000"
                          step="1"
                          placeholder="—"
                          value={amounts[v.id!] ?? ""}
                          onChange={(e) => {
                            setAmounts((current) => ({
                              ...current,
                              [v.id!]: e.target.value,
                            }));
                            write.setDirty(true);
                          }}
                        />
                        <strong>
                          {Number.isFinite(after(v)) ? after(v) : "—"}
                        </strong>
                      </label>
                    ))}
                  </div>
                  <label>
                    Reason for this stock update
                    <input
                      aria-label="Reason for this stock update"
                      value={reason}
                      required
                      minLength={8}
                      maxLength={500}
                      placeholder="e.g. Delivery received from supplier"
                      onChange={(e) => {
                        setReason(e.target.value);
                        write.setDirty(true);
                      }}
                    />
                  </label>
                </>
              )
            )}
          </fieldset>
          <button
            type="submit"
            disabled={
              locked ||
              write.needsReload ||
              loading ||
              (mode === "images"
                ? !chosen
                : !valid || !altered || reason.trim().length < 8)
            }
          >
            {write.busy
              ? "Saving…"
              : mode === "images"
                ? `Save image for ${values.length} variants`
                : `Save stock for ${altered} variant${altered === 1 ? "" : "s"}`}
          </button>
        </form>
      )}
    </section>
  );
}

export default function ProductVariantList<T extends Variant>({
  values,
  group,
  productId,
  productImages,
  productPrice,
  productStatus,
  basePath,
  refresh,
  changed,
  blocked,
  children,
}: {
  values: T[];
  group?: ExistingOptionSet;
  productId: string;
  productImages: string[];
  productPrice: number;
  productStatus: string;
  basePath: string;
  refresh: () => Promise<void>;
  changed: (dirty: boolean) => void;
  blocked: boolean;
  children: (value: T) => ReactNode;
}) {
  const [search, setSearch] = useState(""),
    [first, setFirst] = useState(""),
    [second, setSecond] = useState(""),
    [availability, setAvailability] = useState("all");
  const [selected, setSelected] = useState<string[]>([]),
    [mode, setMode] = useState<"images" | "stock" | null>(null),
    [adding, setAdding] = useState(false),
    [notice, setNotice] = useState("");
  const axes = group ? variantAxes(group.name, values) : null;
  const matches = values.filter((v) => {
    const parts = v.value.split(" / ");
    return (
      `${v.value} ${v.sku}`.toLowerCase().includes(search.toLowerCase()) &&
      (!first || (axes?.combined ? parts[0] : v.value) === first) &&
      (!second || parts[1] === second) &&
      (availability === "all" ||
        (availability === "out"
          ? v.quantity === 0
          : v.quantity !== null && v.quantity > 0))
    );
  });
  const selectedValues = values.filter((v) => v.id && selected.includes(v.id));
  const hidden = selectedValues.filter((v) => !matches.includes(v)).length;
  const selectable = matches.filter((v) => v.id);
  const allSelected =
    selectable.length > 0 && selectable.every((v) => selected.includes(v.id!));
  const matchingSelection = [
    ...new Set([...selected, ...selectable.map((v) => v.id!)]),
  ];
  const selectionTooLarge = !allSelected && matchingSelection.length > 50;
  const busy = !!mode || adding;
  const canStock =
    selectedValues.length > 0 &&
    selectedValues.every(
      (v) =>
        v.stockId && v.quantity !== null && v.stockSource === "Choice stock",
    );
  const main = useRef<HTMLDivElement>(null);
  const close = () => {
    setMode(null);
    changed(false);
    requestAnimationFrame(() => main.current?.focus());
  };
  return (
    <div ref={main} tabIndex={-1} className="ecom-variant-manager">
      <div className="ecom-variant-filters">
        <label>
          Find a variant
          <input
            aria-label="Find a variant"
            placeholder="Search name or SKU"
            value={search}
            disabled={busy}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {axes && axes.first.length > 1 && (
          <label>
            {axes.names[0]}
            <select
              aria-label={`Filter by ${axes.names[0].toLowerCase()}`}
              value={first}
              disabled={busy}
              onChange={(e) => setFirst(e.target.value)}
            >
              <option value="">
                All {axes.names[0].toLowerCase()} choices
              </option>
              {axes.first.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        )}
        {axes?.combined && axes.second.length > 1 && (
          <label>
            {axes.names[1]}
            <select
              aria-label={`Filter by ${axes.names[1].toLowerCase()}`}
              value={second}
              disabled={busy}
              onChange={(e) => setSecond(e.target.value)}
            >
              <option value="">
                All {axes.names[1].toLowerCase()} choices
              </option>
              {axes.second.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Availability
          <select
            aria-label="Filter by availability"
            value={availability}
            disabled={busy}
            onChange={(e) => setAvailability(e.target.value)}
          >
            <option value="all">All stock levels</option>
            <option value="available">In stock</option>
            <option value="out">Out of stock</option>
          </select>
        </label>
      </div>
      <div className="ecom-variant-list-heading">
        <p role="status">
          Showing {matches.length} of {values.length} variants
        </p>
        {(search || first || second || availability !== "all") && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSearch("");
              setFirst("");
              setSecond("");
              setAvailability("all");
            }}
          >
            Clear filters
          </button>
        )}
        {group && (
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => setAdding(true)}
          >
            {axes?.combined ? "Add sizes or colours" : "Add more choices"}
          </button>
        )}
      </div>
      {!busy && blocked && (
        <p className="ecom-variant-help">
          Save your open variant edits before applying a change to several
          variants.
        </p>
      )}
      {adding && group && (
        <div>
          <ProductChoiceSetup
            existing={group}
            onCancel={() => {
              setAdding(false);
              changed(false);
            }}
            productId={productId}
            basePath={basePath}
            refresh={refresh}
            changed={changed}
            productImages={productImages}
            productPrice={productPrice}
            productStatus={productStatus}
            onContinue={() => {
              setAdding(false);
              changed(false);
              setSearch("");
              setFirst("");
              setSecond("");
              setAvailability("all");
            }}
          />
        </div>
      )}
      {!adding && (
        <>
          <div
            className="ecom-variant-selection"
            role="group"
            aria-label="Variant selection"
          >
            <label>
              <input
                type="checkbox"
                aria-label="Select matching variants"
                checked={allSelected}
                disabled={busy || !selectable.length || selectionTooLarge}
                onChange={() => {
                  setSelected(
                    allSelected
                      ? selected.filter(
                          (id) => !selectable.some((v) => v.id === id),
                        )
                      : matchingSelection,
                  );
                  setNotice("");
                }}
              />
              Select matching variants
            </label>
            <span>
              {selectedValues.length} selected
              {hidden ? ` · ${hidden} hidden by filters` : ""}
            </span>
            {selectedValues.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected([])}
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  disabled={busy || blocked}
                  onClick={() => setMode("images")}
                >
                  Change images
                </button>
                <button
                  type="button"
                  disabled={busy || blocked || !canStock}
                  onClick={() => setMode("stock")}
                >
                  Update stock
                </button>
              </>
            )}
          </div>
          {selectionTooLarge && (
            <p className="ecom-variant-help">
              Filter by a size or colour to select up to 50 variants at a time.
            </p>
          )}
          {selectedValues.length > 0 && !canStock && (
            <p className="ecom-variant-help">
              Some selected variants use shared inventory or do not track stock.
              Open their inventory controls to update the source.
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {mode && group && (
            <BulkVariantEditor
              mode={mode}
              groupId={group.id}
              values={selectedValues}
              images={productImages}
              basePath={basePath}
              refresh={refresh}
              changed={changed}
              close={close}
            />
          )}
          {!matches.length && (
            <p className="ecom-variant-empty">
              No variants match these filters. Clear the filters to see every
              size and colour.
            </p>
          )}
          <div className="ecom-variant-results" inert={!!mode}>
            {values.map((value) => (
              <div
                key={value.localId}
                hidden={!matches.includes(value)}
                className="ecom-variant-selectable"
              >
                <label className="ecom-variant-check">
                  <input
                    type="checkbox"
                    aria-label={`Select ${value.value || "new variant"}`}
                    disabled={!value.id || busy}
                    checked={!!value.id && selected.includes(value.id)}
                    onChange={() => {
                      if (!value.id) return;
                      if (selected.includes(value.id))
                        setSelected(selected.filter((id) => id !== value.id));
                      else if (selected.length < 50)
                        setSelected([...selected, value.id]);
                      else
                        setNotice("You can update up to 50 variants together.");
                    }}
                  />
                </label>
                {children(value)}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
