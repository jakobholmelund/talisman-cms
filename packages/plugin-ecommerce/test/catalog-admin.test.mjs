import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyAllMigrations } from "./helpers/migrations.mjs";
import { createCommerceCatalogSeedSql } from "../dist/catalog.js";
import {
  readAdminCatalogue,
  readCatalogueSelection,
  updateCatalogue,
} from "../dist/operations.js";
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  applyAllMigrations(sqlite);
  const DB = {
    prepare(query) {
      const stmt = sqlite.prepare(query);
      let values = [];
      return {
        bind(...p) {
          assert.ok(p.length <= 100);
          values = p;
          return this;
        },
        async all() {
          return { results: stmt.all(...values) };
        },
        async first() {
          return stmt.get(...values);
        },
        async raw() {
          const s = sqlite.prepare(query);
          s.setReturnArrays(true);
          return s.all(...values);
        },
        async run() {
          return { meta: stmt.run(...values) };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.all());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  sqlite.exec(
    createCommerceCatalogSeedSql({
      products: [
        ...Array.from({ length: 60 }, (_, i) => ({
          id: `p${String(i).padStart(2, "0")}`,
          name: `Object ${String(i).padStart(2, "0")}`,
          slug: `object-${i}`,
          sku: `ITEM-${i}`,
          basePrice: 1000 + i,
          inventoryQuantity: i % 3 === 0 ? 0 : i % 3 === 1 ? 3 : 20,
          images: i % 2 ? ["/photo.png"] : [],
          status: i % 2 ? "active" : "draft",
        })),
        {
          id: "digital",
          name: "Digital",
          slug: "digital",
          basePrice: 2000,
          type: "digital",
          status: "active",
          images: ["/digital.png"],
        },
        {
          id: "frame",
          name: "Frame",
          slug: "frame",
          basePrice: 5000,
          status: "active",
          categoryIds: ["frames"],
          images: ["/frame.png"],
        },
        {
          id: "legacy",
          name: "Legacy",
          slug: "legacy",
          basePrice: 2000,
          status: "archived",
        },
      ],
      categories: [{ id: "frames", name: "Frames", slug: "frames" }],
      productVariants: [
        {
          id: "g",
          productId: "frame",
          name: "Lens",
          inventoryQuantity: 90,
          priceOverride: 4000,
        },
        { id: "lg", productId: "legacy", name: "Size", inventoryQuantity: 2 },
      ],
      variantValues: [
        {
          id: "amber",
          productVariantId: "g",
          value: "Amber",
          sku: "UNIQUE-AMBER",
          priceOverride: 3000,
        },
        { id: "smoke", productVariantId: "g", value: "Smoke" },
      ],
      components: [
        { id: "part", sku: "PART", name: "Shared part", quantity: 4 },
      ],
      variantComponents: [
        {
          id: "recipe",
          productVariantValueId: "amber",
          componentId: "part",
          quantity: 2,
        },
      ],
    }),
  );
  sqlite.exec(
    "INSERT INTO _ecommerce_stocks(id,product_variant_value_id,quantity,created_at,updated_at) VALUES ('as','amber',100,1,1),('ss','smoke',0,1,1)",
  );
  return { sqlite, env: { DB } };
}
test("catalogue attention searches all products before paging and uses effective choice stock", async () => {
  const { sqlite, env } = fixture();
  try {
    const first = await readAdminCatalogue(env, { sort: "name" }),
      second = await readAdminCatalogue(env, { sort: "name", page: 2 }),
      last = await readAdminCatalogue(env, { sort: "name", page: 999 });
    assert.equal(first.total, 63);
    assert.equal(first.rows.length, 25);
    assert.equal(last.page, 3);
    assert.equal(last.rows.length, 13);
    assert.ok(!first.rows.some((r) => second.rows.some((s) => s.id === r.id)));
    assert.equal(first.counts.images, 31);
    assert.equal(first.counts.low, 22);
    assert.equal(first.counts.out, 21);
    const frame = (await readAdminCatalogue(env, { search: "UNIQUE-AMBER" }))
      .rows[0];
    assert.equal(frame.id, "frame");
    assert.deepEqual(
      [frame.lowCount, frame.outCount, frame.inStock, frame.choiceCount],
      [1, 1, 1, 2],
    );
    assert.deepEqual(
      [frame.minPrice, frame.maxPrice, frame.customPrices],
      [3000, 4000, 2],
    );
    assert.equal(
      (await readAdminCatalogue(env, { category: "frames", attention: "low" }))
        .total,
      1,
    );
    assert.equal(
      (await readAdminCatalogue(env, { search: "ITEM-59" })).rows[0].id,
      "p59",
    );
    assert.equal((await readAdminCatalogue(env, { search: "%_" })).total, 0);
    const digital = (await readAdminCatalogue(env, { search: "Digital" }))
      .rows[0];
    assert.deepEqual(
      [digital.inStock, digital.outCount, digital.lowCount],
      [1, 0, 0],
    );
    const filters = await readAdminCatalogue(env, {
      status: "draft",
      attention: "images",
    });
    assert.equal(filters.total, 30);
    assert.equal(filters.counts.all, 30);
    sqlite.exec(
      "UPDATE _ecommerce_products SET base_price=0 WHERE id='p59'; UPDATE _ecommerce_products SET images='[\"\",{\"url\":\"/real.png\"}]' WHERE id='p00'",
    );
    assert.equal(
      (await readAdminCatalogue(env, { attention: "price" })).total,
      1,
    );
    assert.equal(
      (await readAdminCatalogue(env, { search: "ITEM-0" })).rows[0].image,
      "/real.png",
    );
  } finally {
    sqlite.close();
  }
});
test("bulk catalogue changes are atomic and absolute retries never compound prices or touch variants and stock", async () => {
  const { sqlite, env } = fixture();
  try {
    const before = await readCatalogueSelection(env, { ids: ["p00", "frame"] });
    const input = {
      kind: "price",
      requestKey: crypto.randomUUID(),
      rows: before.rows.map((r) => ({
        id: r.id,
        expectedUpdatedAt: r.updatedAt,
        basePrice: r.basePrice + 500,
      })),
    };
    const variant = sqlite
      .prepare("SELECT * FROM _ecommerce_product_variants WHERE id=?")
      .get("g");
    const stock = sqlite
      .prepare("SELECT * FROM _ecommerce_stocks ORDER BY id")
      .all();
    const first = await updateCatalogue(env, input, "admin");
    assert.deepEqual(await updateCatalogue(env, input, "admin"), first);
    assert.equal(
      sqlite
        .prepare("SELECT base_price FROM _ecommerce_products WHERE id=?")
        .get("p00").base_price,
      1500,
    );
    assert.deepEqual(
      sqlite
        .prepare("SELECT * FROM _ecommerce_product_variants WHERE id=?")
        .get("g"),
      variant,
    );
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM _ecommerce_stocks ORDER BY id").all(),
      stock,
    );
    const fresh = await readCatalogueSelection(env, { ids: ["p00", "frame"] });
    sqlite
      .prepare(
        "UPDATE _ecommerce_products SET updated_at=updated_at+1,name=? WHERE id=?",
      )
      .run("Concurrent edit", "p00");
    await assert.rejects(
      updateCatalogue(
        env,
        {
          kind: "visibility",
          requestKey: crypto.randomUUID(),
          rows: fresh.rows.map((r) => ({
            id: r.id,
            expectedUpdatedAt: r.updatedAt,
            status: "archived",
          })),
        },
        "admin",
      ),
      /Products changed/,
    );
    assert.equal(
      sqlite
        .prepare("SELECT status FROM _ecommerce_products WHERE id=?")
        .get("frame").status,
      "active",
    );
    await assert.rejects(
      readCatalogueSelection(env, { ids: ["p00", "missing"] }),
      /no longer/,
    );
    await assert.rejects(
      updateCatalogue(
        env,
        { ...input, rows: [{ ...input.rows[0], basePrice: 0 }] },
        "admin",
      ),
    );
    await assert.rejects(
      updateCatalogue(
        env,
        { ...input, rows: [{ ...input.rows[0], basePrice: 1.5 }] },
        "admin",
      ),
    );
  } finally {
    sqlite.close();
  }
});
