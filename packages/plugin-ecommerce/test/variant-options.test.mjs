import test from "node:test";
import assert from "node:assert/strict";
import { compileModule, pluginAdmin } from "./helpers/admin-source.mjs";
const { additionalChoices, variantAxes, inheritedPhotos } = await import(
  compileModule(new URL("variant-options.ts", pluginAdmin))
);
const existing = {
  id: "shirt",
  name: "Size / Colour",
  updatedAt: "2026-11-17T00:00:00Z",
  values: [
    "Small / Blue",
    "Small / Rust",
    "Medium / Blue",
    "Medium / Rust",
  ].map((value) => ({
    value,
    image: value.endsWith("Blue") ? "/blue.png" : "",
  })),
};
test("new sizes and colours extend the same matrix once, keeping existing combinations", () => {
  assert.deepEqual(
    additionalChoices(existing, ["Large"], ["Green"]).map((v) => v.label),
    [
      "Small / Green",
      "Medium / Green",
      "Large / Blue",
      "Large / Rust",
      "Large / Green",
    ],
  );
  assert.deepEqual(additionalChoices(existing, ["small"], ["blue"]), []);
  assert.deepEqual(inheritedPhotos(existing), { Blue: "/blue.png", Rust: "" });
});
test("ambiguous legacy labels are treated as complete choices, and mixed colour photos are not guessed", () => {
  assert.equal(
    variantAxes("Size / Colour", [{ value: "Small / Blue / Special" }])
      .combined,
    false,
  );
  const mixed = structuredClone(existing);
  mixed.values[2].image = "/other.png";
  assert.equal(inheritedPhotos(mixed).Blue, undefined);
  const simple = {
    ...existing,
    name: "Size",
    values: [{ value: "Small", image: "" }],
  };
  assert.deepEqual(additionalChoices(simple, ["Medium", "medium"], []), [
    { label: "Medium", photoKey: "Medium" },
  ]);
});
test("oversized additions stop previewing after the batch limit without building the whole matrix", () => {
  const additions = additionalChoices(
    existing,
    Array.from({ length: 2000 }, (_, i) => `Size ${i}`),
    Array.from({ length: 2000 }, (_, i) => `Colour ${i}`),
  );
  assert.equal(additions.length, 51);
});
