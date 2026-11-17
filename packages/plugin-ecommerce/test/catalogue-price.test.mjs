import assert from "node:assert/strict";
import { test } from "node:test";
import { compileModule, pluginAdmin } from "./helpers/admin-source.mjs";
const { cataloguePrice, catalogueRange } = await import(
  compileModule(new URL("catalogue-price.ts", pluginAdmin))
);
test("bulk price preview uses currency-independent minor units and bounds percentage adjustments", () => {
  assert.equal(cataloguePrice(999, "increase", "10"), 1099);
  assert.equal(cataloguePrice(999, "decrease", "10"), 899);
  assert.equal(cataloguePrice(100, "increase", "0.5"), 101);
  assert.equal(cataloguePrice(1, "set", "2500"), 2500);
  assert.equal(cataloguePrice(100, "decrease", "100"), null);
  assert.equal(cataloguePrice(Number.MAX_SAFE_INTEGER, "increase", "1"), null);
  assert.equal(cataloguePrice(0, "increase", "10"), null);
  assert.equal(cataloguePrice(1, "set", "invalid"), null);
  assert.deepEqual(
    catalogueRange(
      { minCustom: 3000, maxCustom: 5000, inheritedPrices: 2 },
      2000,
    ),
    { min: 2000, max: 5000 },
  );
  assert.deepEqual(
    catalogueRange(
      { minCustom: 3000, maxCustom: 5000, inheritedPrices: 0 },
      9000,
    ),
    { min: 3000, max: 5000 },
  );
});
