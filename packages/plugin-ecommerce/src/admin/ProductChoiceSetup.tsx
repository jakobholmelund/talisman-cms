import React, { useRef, useState } from "react";
import { requestEditorApi } from "talisman-cms/ui/lib/entry-editor-data";
import { MediaFieldInput } from "talisman-cms/ui/components/MediaFieldInput";
import { finishProductSetup, type SetupPlan } from "./product-setup";
import { formatMoney } from "./commerce-models";
import { storeCurrency } from "./currency";

import {
  additionalChoices,
  inheritedPhotos,
  variantAxes,
  type ExistingOptionSet,
} from "./variant-options";

const split = (value: string) =>
  value
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
export default function ProductChoiceSetup({
  productId,
  existing,
  basePath,
  refresh,
  changed,
  productImages = [],
  productPrice,
  productStatus,
  onNoVariants,
  onContinue,
  onCancel,
}: {
  productId: string;
  existing?: ExistingOptionSet;
  basePath: string;
  refresh: () => Promise<void>;
  changed: (dirty: boolean) => void;
  productImages?: string[];
  productPrice?: number;
  productStatus?: string;
  onNoVariants?: () => void;
  onContinue: () => void;
  onCancel?: () => void;
}) {
  const axes = existing ? variantAxes(existing.name, existing.values) : null;
  const [firstName, setFirstName] = useState(axes?.names[0] || "Size"),
    [secondName, setSecondName] = useState(axes?.names[1] || "Colour");
  const [first, setFirst] = useState(""),
    [second, setSecond] = useState(""),
    [combined, setCombined] = useState(axes?.combined ?? true);
  const [step, setStep] = useState<"choices" | "review" | "done">("choices");
  const [quantities, setQuantities] = useState<Record<string, string>>({}),
    [photos, setPhotos] = useState<Record<string, string>>(() =>
      existing ? inheritedPhotos(existing) : {},
    );
  const [allStock, setAllStock] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<SetupPlan | null>(null),
    [done, setDone] = useState({ count: 0, units: 0 });
  const writing = useRef(false),
    feedback = useRef<HTMLParagraphElement>(null);
  const a = split(first),
    b = split(second),
    count = a.length * (combined ? b.length : 1);
  const choices = existing
    ? additionalChoices(existing, a, b)
    : count > 50
      ? []
      : a.flatMap((value) =>
          combined
            ? b.map((other) => ({
                label: `${value} / ${other}`,
                photoKey: other,
              }))
            : [{ label: value, photoKey: value }],
        );
  const photoKeys = [...new Set(choices.map((choice) => choice.photoKey))];
  const touch = () => {
    changed(true);
    setError("");
  };
  const fail = (message: string) => {
    setError(message);
    requestAnimationFrame(() => feedback.current?.focus());
  };
  function review() {
    if (!firstName.trim() || (combined && !secondName.trim()))
      return fail("Name each option before continuing.");
    if (existing && !choices.length)
      return fail(
        "Add a new size or colour. Existing combinations are already saved.",
      );
    if (!existing && !a.length)
      return fail(`Add at least one ${firstName.toLowerCase()} to continue.`);
    if (!existing && combined && !b.length)
      return fail(`Add at least one ${secondName.toLowerCase()} to continue.`);
    if (choices.length > 50 || (!existing && count > 50))
      return fail(
        "There are more than 50 variants. Use fewer sizes or colours.",
      );
    if (
      new Set(choices.map((choice) => choice.label.toLowerCase())).size !==
      choices.length
    )
      return fail(
        "Some choices are repeated. Keep each size and colour only once.",
      );
    if (choices.some((choice) => choice.label.length > 200))
      return fail("Keep each variant name under 200 characters.");
    setStep("review");
    touch();
  }
  async function save() {
    if (writing.current) return;
    const stock = choices.map((choice) => quantities[choice.label] ?? "0");
    if (
      !pending &&
      stock.some(
        (quantity) => !/^\d+$/.test(quantity) || Number(quantity) > 1000000,
      )
    )
      return fail(
        "Enter a whole number from 0 to 1,000,000 for each starting stock quantity.",
      );
    const plan = pending ?? {
      create: {
        action: existing
          ? ("addOptionValues" as const)
          : ("createOptionSet" as const),
        productId,
        requestKey: crypto.randomUUID(),
        ...(existing
          ? { groupId: existing.id, expectedUpdatedAt: existing.updatedAt }
          : {
              name: combined
                ? `${firstName.trim()} / ${secondName.trim()}`
                : firstName.trim(),
            }),
        values: choices.map((choice) => choice.label),
        images: choices.map((choice) => photos[choice.photoKey] || null),
      },
      quantities: stock.map(Number),
    };
    writing.current = true;
    setPending(plan);
    setBusy(true);
    setError("");
    changed(true);
    try {
      await finishProductSetup(plan, (path, body) =>
        requestEditorApi(
          `${basePath}/api/ecommerce/${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          "Could not finish product setup",
        ),
      );
      await refresh();
      setDone({
        count: plan.create.values.length,
        units: plan.quantities.reduce((sum, n) => sum + n, 0),
      });
      setPending(null);
      setStep("done");
      changed(false);
    } catch (cause) {
      fail(
        cause instanceof Error
          ? cause.message
          : "Setup could not be confirmed. Retry to continue safely.",
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const locked = busy || !!pending;
  return (
    <section
      className="ecom-choice-setup"
      aria-label={existing ? "Add product variants" : "Create product choices"}
    >
      <div
        className="ecom-setup-steps"
        role="group"
        aria-label="Variant setup progress"
      >
        <span aria-current={step === "choices" ? "step" : undefined}>
          1 · Sizes & colours
        </span>
        <span aria-current={step === "review" ? "step" : undefined}>
          2 · Photos & starting stock
        </span>
        <span aria-current={step === "done" ? "step" : undefined}>
          3 · Ready
        </span>
      </div>
      {onCancel && step !== "done" && (
        <button type="button" disabled={locked} onClick={onCancel}>
          Cancel additions
        </button>
      )}
      {step === "choices" && (
        <>
          <h3>
            {existing
              ? "Add to your existing variants"
              : "What can shoppers choose?"}
          </h3>
          {axes && (
            <p>
              Already available: {axes.first.join(", ")}
              {axes.combined ? ` · ${axes.second.join(", ")}` : ""}. Only new
              combinations will be added.
            </p>
          )}
          {onNoVariants && (
            <button type="button" onClick={onNoVariants}>
              Sell without variants
            </button>
          )}
          {!existing && (
            <div
              className="ecom-setup-presets"
              role="group"
              aria-label="Types of variants"
            >
              {[
                { label: "Sizes & colours", name: "Size", both: true },
                { label: "Sizes only", name: "Size", both: false },
                { label: "Colours only", name: "Colour", both: false },
                { label: "Something else", name: "Option", both: false },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={
                    combined === preset.both && firstName === preset.name
                  }
                  onClick={() => {
                    if (firstName !== preset.name) setFirst("");
                    setFirstName(preset.name);
                    setCombined(preset.both);
                    touch();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <div className="ecom-choice-setup__fields">
            <label>
              {existing
                ? `New ${firstName.toLowerCase()} choices`
                : firstName === "Size"
                  ? "Sizes"
                  : firstName === "Colour"
                    ? "Colours"
                    : "Choices"}
              <textarea
                aria-label={
                  existing
                    ? `New ${firstName.toLowerCase()} choices`
                    : firstName === "Size"
                      ? "Sizes"
                      : firstName === "Colour"
                        ? "Colours"
                        : "Choices"
                }
                value={first}
                maxLength={10000}
                rows={2}
                placeholder={
                  firstName === "Size" ? "Small, Medium, Large" : "Blue, Black"
                }
                onChange={(event) => {
                  setFirst(event.target.value);
                  touch();
                }}
              />
              <small>Type a list separated by commas or new lines.</small>
            </label>
            {combined && (
              <label>
                {existing
                  ? `New ${secondName.toLowerCase()} choices`
                  : "Colours"}
                <textarea
                  aria-label={
                    existing
                      ? `New ${secondName.toLowerCase()} choices`
                      : "Colours"
                  }
                  value={second}
                  rows={2}
                  maxLength={10000}
                  placeholder="Blue, Black"
                  onChange={(event) => {
                    setSecond(event.target.value);
                    touch();
                  }}
                />
              </label>
            )}
          </div>
          {!existing && (
            <details className="ecom-setup-custom-names">
              <summary>Customise option names</summary>
              <label>
                Option name
                <input
                  value={firstName}
                  maxLength={90}
                  onChange={(event) => {
                    setFirstName(event.target.value);
                    touch();
                  }}
                />
              </label>
              {combined && (
                <label>
                  Second option name
                  <input
                    value={secondName}
                    maxLength={90}
                    onChange={(event) => {
                      setSecondName(event.target.value);
                      touch();
                    }}
                  />
                </label>
              )}
            </details>
          )}
          <p>
            {existing
              ? `${choices.length > 50 ? "More than 50" : choices.length} new variants · ${existing.values.length} existing variants kept`
              : count > 0
                ? `${a.length}${combined ? ` sizes × ${b.length} colours = ${count}` : ""} variant${count === 1 ? "" : "s"}`
                : "Add your choices to see the variants you’ll create."}
          </p>
          {choices.length > 0 && (
            <div
              className="ecom-choice-setup__chips"
              role="group"
              aria-label="Variants to create"
            >
              {choices.map((choice) => (
                <span key={choice.label}>{choice.label}</span>
              ))}
            </div>
          )}
          <button type="button" onClick={review}>
            Continue to photos & stock
          </button>
        </>
      )}
      {step === "review" && (
        <>
          <h3>Photos and stock for each variant</h3>
          <p>
            {existing ? "New variants start at" : "All variants start at"}{" "}
            {formatMoney(productPrice, storeCurrency()) || "the product price"}.
            You can change individual prices later.
          </p>
          <fieldset disabled={locked} className="ecom-setup-review-fields">
            <div className="ecom-setup-photos">
              {photoKeys.map((key) => (
                <section key={key} aria-label={`Photo for ${key}`}>
                  <h4>{key}</h4>
                  <p>
                    {combined
                      ? existing
                        ? `Used for new variants in ${key}. Existing photos stay as they are.`
                        : `Used for every size in ${key}.`
                      : "Photo for this variant."}
                  </p>
                  {(photos[key] || productImages[0]) && (
                    <img
                      src={photos[key] || productImages[0]}
                      alt={`${key} variant preview`}
                      className="ecom-setup-photo-preview"
                    />
                  )}
                  <div
                    className="ecom-setup-photo-choices"
                    role="group"
                    aria-label={`Product photos for ${key}`}
                  >
                    <button
                      type="button"
                      aria-pressed={!photos[key]}
                      onClick={() => {
                        setPhotos((current) => ({ ...current, [key]: "" }));
                        touch();
                      }}
                    >
                      Use main image
                    </button>
                    {productImages.map((image, index) => (
                      <button
                        key={`${image}-${index}`}
                        type="button"
                        aria-label={`Use product image ${index + 1} for ${key}`}
                        aria-pressed={photos[key] === image}
                        onClick={() => {
                          setPhotos((current) => ({
                            ...current,
                            [key]: image,
                          }));
                          touch();
                        }}
                      >
                        <img src={image} alt="" />
                      </button>
                    ))}
                  </div>
                  <details>
                    <summary>Upload or choose another photo</summary>
                    <MediaFieldInput
                      pickerOnly
                      adminBasePath={basePath}
                      value={photos[key] || ""}
                      label={`Photo for ${key}`}
                      onChange={(image) => {
                        setPhotos((current) => ({ ...current, [key]: image }));
                        touch();
                      }}
                    />
                  </details>
                </section>
              ))}
            </div>
            <div className="ecom-setup-stock-heading">
              <div>
                <h4>Starting stock</h4>
                <p>
                  How many do you have ready to sell? Use 0 for anything not in
                  stock yet.
                </p>
              </div>
              <label>
                Same stock for every variant
                <input
                  aria-label="Same stock for every variant"
                  inputMode="numeric"
                  value={allStock}
                  onChange={(event) => setAllStock(event.target.value)}
                  placeholder="e.g. 10"
                />
              </label>
              <button
                type="button"
                disabled={!/^\d+$/.test(allStock) || Number(allStock) > 1000000}
                onClick={() => {
                  setQuantities((current) => ({
                    ...current,
                    ...Object.fromEntries(
                      choices.map((choice) => [choice.label, allStock]),
                    ),
                  }));
                  touch();
                }}
              >
                Apply to all
              </button>
            </div>
            <div className="ecom-setup-stock-list">
              {choices.map((choice) => (
                <label key={choice.label}>
                  <span>{choice.label}</span>
                  <input
                    aria-label={`Starting stock for ${choice.label}`}
                    type="number"
                    min={0}
                    max={1000000}
                    step={1}
                    value={quantities[choice.label] ?? "0"}
                    onChange={(event) => {
                      setQuantities((current) => ({
                        ...current,
                        [choice.label]: event.target.value,
                      }));
                      touch();
                    }}
                  />
                  <small>units</small>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="ecom-setup-actions">
            <button
              type="button"
              disabled={locked}
              onClick={() => setStep("choices")}
            >
              Back to choices
            </button>
            <button type="button" disabled={busy} onClick={() => void save()}>
              {busy
                ? "Saving variants & stock…"
                : pending
                  ? "Retry and finish setup"
                  : `${existing ? "Add" : "Create"} ${choices.length} variants & save stock`}
            </button>
          </div>
          {pending?.groupId && !pending.complete && (
            <p role="status">
              Your variants are saved. Starting stock still needs confirmation.
              Retrying continues this setup without creating duplicates.
            </p>
          )}
          {pending && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                try {
                  await refresh();
                  setPending(null);
                  changed(false);
                  onContinue();
                } catch (cause) {
                  fail(
                    cause instanceof Error
                      ? cause.message
                      : "Could not load saved variants.",
                  );
                }
              }}
            >
              Review saved variants instead
            </button>
          )}
        </>
      )}
      {step === "done" && (
        <div className="ecom-setup-success">
          <h3>Your variants are ready</h3>
          <p role="status">
            {done.count} variants {existing ? "added" : "created"} ·{" "}
            {done.units} units recorded.
          </p>
          <p>
            {productStatus === "active"
              ? "Your product is available in the store."
              : productStatus === "archived"
                ? "Your product is archived and hidden from shoppers."
                : "Saved as a draft. Shoppers cannot see this product yet."}
          </p>
          <button type="button" onClick={onContinue}>
            View variants
          </button>
          {productStatus !== "active" && (
            <button
              type="button"
              onClick={() => {
                const field = document.querySelector(
                  '[data-field-path="status"]',
                );
                field?.scrollIntoView({ block: "center" });
                (
                  field?.querySelector("select") as HTMLSelectElement | null
                )?.focus();
              }}
            >
              Review visibility
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setFirst("");
              setSecond("");
              setQuantities({});
              setPhotos(existing ? inheritedPhotos(existing) : {});
              setStep("choices");
            }}
          >
            Add more variants
          </button>
        </div>
      )}
      <p ref={feedback} tabIndex={-1} role="alert">
        {error}
      </p>
    </section>
  );
}
