import assert from "node:assert/strict";
import axe from "axe-core";
import { mkdir } from "node:fs/promises";

export async function existingProductFlow(
  ctx,
  { expectVisible, waitUntil, makePng },
) {
  const page = await ctx.admin.context.newPage();
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => d.dismiss());
  const origin = ctx.options.baseUrl;
  const post = async (path, body) => {
    const r = await page.request.post(`/admin/api/ecommerce/${path}`, {
      headers: { Origin: origin },
      data: body,
    });
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const read = async (slug, id) => {
    const r = await page.request.get(
      `/admin/api/collections/${slug}/entries/${id}`,
    );
    assert.ok(r.ok());
    const d = await r.json();
    return d.data ?? d;
  };
  const list = async (slug, key, id) => {
    const r = await page.request.get(
      `/admin/api/collections/${slug}/entries?where[${key}]=${id}&limit=100`,
    );
    assert.ok(r.ok());
    return (await r.json()).docs.map((v) => ({ id: v.id, ...(v.data ?? v) }));
  };
  const scan = async (name) => {
    if (!(await page.evaluate(() => !!window.axe)))
      await page.evaluate(axe.source);
    const result = await page.evaluate(() =>
      window.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      }),
    );
    (ctx.state.accessibility ??= []).push({
      name,
      url: page.url(),
      viewport: page.viewportSize(),
      violations: result.violations,
      incomplete: result.incomplete,
    });
    assert.deepEqual(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
    );
  };
  let productId;
  try {
    await page.goto("/admin/commerce/products/new");
    await page
      .locator("[data-field-path=name] input")
      .fill(`Everyday shirt ${ctx.runId}`);
    await page
      .getByRole("textbox", { name: "Price (USD)", exact: true })
      .fill("49");
    const gallery = page.locator("[data-field-path=images]");
    for (const [i, colour] of [
      [1, [40, 60, 130]],
      [2, [160, 75, 40]],
    ]) {
      await gallery.locator("input[type=file]").setInputFiles({
        name: `existing-${ctx.runId}-${i}.png`,
        mimeType: "image/png",
        buffer: makePng(100, 100, colour),
      });
      await expectVisible(
        gallery.getByRole("img", { name: `Product image ${i}`, exact: true }),
        "product photo",
      );
    }
    const photo = await gallery
      .getByRole("img", { name: "Product image 2", exact: true })
      .getAttribute("src");
    await page
      .getByRole("button", { name: "Create product", exact: true })
      .click();
    await page.waitForURL((url) =>
      /\/products\/(?!new$)[^/]+$/.test(url.pathname),
    );
    productId = new URL(page.url()).pathname.split("/").pop();
    const sizes = [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "2XL",
      "3XL",
      "4XL",
      "5XL",
      "6XL",
    ];
    const labels = sizes.flatMap((size) =>
      ["Navy", "Rust", "Cream", "Black"].map((colour) => `${size} / ${colour}`),
    );
    const key = crypto.randomUUID();
    const {
      result: { groupId },
    } = await post("variants", {
      action: "createOptionSet",
      productId,
      requestKey: key,
      name: "Size / Colour",
      values: labels,
      images: labels.map((v) => (v.endsWith("Rust") ? photo : null)),
    });
    let values = await list(
      "_ecommerce_product_variant_values",
      "productVariantId",
      groupId,
    );
    const first = values.find((v) => v.value === "XS / Navy");
    await post("variants", {
      action: "saveValue",
      groupId,
      value: {
        id: first.id,
        expectedUpdatedAt: first.updatedAt,
        value: first.value,
        sku: `KEEP-${ctx.runId}`,
        image: null,
        priceOverride: 5900,
      },
    });
    const snapshot = await post("operations", {
      action: "stocktakeRead",
      data: {
        targets: values.map((v) => ({
          targetType: "stock",
          targetId: `stock_${v.id}`,
        })),
      },
    });
    await post("operations", {
      action: "stocktake",
      data: {
        requestKey: crypto.randomUUID(),
        reason: "Opening stock for existing product test",
        lines: snapshot.rows.map((v) => ({
          targetType: "stock",
          targetId: v.id,
          expectedQuantity: v.quantity,
          expectedUpdatedAt: v.updatedAt,
          countedQuantity: 1,
        })),
      },
    });
    values = await list(
      "_ecommerce_product_variant_values",
      "productVariantId",
      groupId,
    );
    const before = structuredClone(values);
    await page.reload();
    await page
      .getByRole("link", { name: "Variants & inventory", exact: true })
      .click();
    await expectVisible(
      page.getByText("Showing 40 of 40 variants", { exact: true }),
      "large saved list",
    );
    await page
      .getByRole("button", { name: "Add sizes or colours", exact: true })
      .click();
    const setup = page.getByRole("region", {
      name: "Add product variants",
      exact: true,
    });
    await setup.getByLabel("New size choices", { exact: true }).fill("7XL");
    await setup.getByLabel("New colour choices", { exact: true }).fill("Olive");
    await expectVisible(
      setup.getByText("15 new variants · 40 existing variants kept", {
        exact: true,
      }),
      "only missing combinations previewed",
    );
    await setup
      .getByRole("button", { name: "Continue to photos & stock", exact: true })
      .click();
    await setup
      .getByLabel("Same stock for every variant", { exact: true })
      .fill("2");
    await setup
      .getByRole("button", { name: "Apply to all", exact: true })
      .click();
    const append = [];
    await page.route("**/api/ecommerce/variants", async (r) => {
      const b = r.request().postDataJSON();
      if (b.action !== "addOptionValues") return r.continue();
      append.push(b);
      if (append.length === 1) {
        const response = await r.fetch();
        assert.ok(response.ok(), await response.text());
        return r.abort("failed");
      }
      return r.continue();
    });
    await setup
      .getByRole("button", {
        name: "Add 15 variants & save stock",
        exact: true,
      })
      .click();
    await setup
      .getByRole("button", { name: "Retry and finish setup", exact: true })
      .click();
    await expectVisible(
      setup.getByRole("status").filter({ hasText: "15 variants added" }),
      "additions recovered",
    );
    assert.deepEqual(append[0], append[1]);
    await page.unroute("**/api/ecommerce/variants");
    await setup
      .getByRole("button", { name: "View variants", exact: true })
      .click();
    await expectVisible(
      page.getByText("Showing 55 of 55 variants", { exact: true }),
      "55 variants in same set",
    );
    assert.equal(
      (await list("_ecommerce_product_variants", "productId", productId))
        .length,
      1,
    );
    values = await list(
      "_ecommerce_product_variant_values",
      "productVariantId",
      groupId,
    );
    for (const row of before)
      assert.deepEqual(
        values.find((v) => v.id === row.id),
        row,
      );
    assert.equal(
      (await read("_ecommerce_stocks", `stock_${first.id}`)).quantity,
      1,
    );
    await page
      .getByLabel("Filter by colour", { exact: true })
      .selectOption("Olive");
    await expectVisible(
      page.getByText("Showing 11 of 55 variants", { exact: true }),
      "colour filter",
    );
    await page
      .getByRole("checkbox", { name: "Select matching variants", exact: true })
      .check();
    await page
      .getByLabel("Filter by size", { exact: true })
      .selectOption("7XL");
    await expectVisible(
      page.getByText("11 selected · 10 hidden by filters", { exact: true }),
      "selection scope stays visible",
    );
    await page.getByLabel("Filter by size", { exact: true }).selectOption("");
    await page
      .getByRole("button", { name: "Change images", exact: true })
      .click();
    const images = page.getByRole("region", {
      name: "Change selected variant images",
      exact: true,
    });
    await images
      .getByRole("button", {
        name: "Use product image 2 for selected variants",
        exact: true,
      })
      .click();
    await scan("existing-product-images");
    const imageWrites = [];
    await page.route("**/api/ecommerce/variants", async (r) => {
      const b = r.request().postDataJSON();
      if (b.action !== "setVariantImages") return r.continue();
      imageWrites.push(b);
      if (imageWrites.length === 1) {
        const response = await r.fetch();
        assert.ok(response.ok());
        return r.abort("failed");
      }
      return r.continue();
    });
    await images
      .getByRole("button", { name: "Save image for 11 variants", exact: true })
      .click();
    await images
      .getByRole("button", { name: "Recover same request", exact: true })
      .click();
    await expectVisible(
      images.getByText("Image updated for 11 variants.", { exact: true }),
      "photos saved",
    );
    assert.deepEqual(imageWrites[0], imageWrites[1]);
    await page.unroute("**/api/ecommerce/variants");
    await images.getByRole("button", { name: "Done", exact: true }).click();
    values = await list(
      "_ecommerce_product_variant_values",
      "productVariantId",
      groupId,
    );
    assert.ok(
      values
        .filter((v) => v.value.endsWith("Olive"))
        .every((v) => v.image === photo),
    );
    for (const row of before)
      assert.deepEqual(
        values.find((v) => v.id === row.id),
        row,
      );
    await page
      .getByLabel("Filter by colour", { exact: true })
      .selectOption("Navy");
    await page
      .getByRole("checkbox", { name: "Select matching variants", exact: true })
      .check();
    await expectVisible(
      page.getByText("22 selected · 11 hidden by filters", { exact: true }),
      "selections accumulate across filters",
    );
    await page
      .getByRole("checkbox", { name: "Select matching variants", exact: true })
      .uncheck();
    await expectVisible(
      page.getByText("11 selected · 11 hidden by filters", { exact: true }),
      "deselecting visible rows keeps hidden selections",
    );
    await page
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await page
      .getByLabel("Filter by colour", { exact: true })
      .selectOption("Navy");
    await page
      .getByRole("checkbox", { name: "Select matching variants", exact: true })
      .check();
    await page
      .getByRole("button", { name: "Update stock", exact: true })
      .click();
    const stock = page.getByRole("region", {
      name: "Update selected variant stock",
      exact: true,
    });
    await stock.getByLabel("Apply quantity to all", { exact: true }).fill("3");
    await stock
      .getByRole("button", { name: "Apply to selected", exact: true })
      .click();
    await stock
      .getByLabel("Add units for XS / Navy", { exact: true })
      .fill("0");
    await stock
      .getByLabel("Reason for this stock update", { exact: true })
      .fill("Delivery arrived, XS excluded");
    await scan("existing-product-stock");
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil("existing variants fit mobile", () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await scan("existing-product-mobile");
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/existing-product-stock-mobile.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const stockWrites = [];
    await page.route("**/api/ecommerce/operations", async (r) => {
      const b = r.request().postDataJSON();
      if (b.action !== "stocktake") return r.continue();
      stockWrites.push(b);
      if (stockWrites.length === 1) {
        const response = await r.fetch();
        assert.ok(response.ok(), await response.text());
        return r.abort("failed");
      }
      return r.continue();
    });
    await stock
      .getByRole("button", { name: "Save stock for 10 variants", exact: true })
      .click();
    await stock
      .getByRole("button", { name: "Recover same request", exact: true })
      .click();
    await expectVisible(
      stock.getByText("Stock updated for 10 variants with staff history.", {
        exact: true,
      }),
      "batch stock saved",
    );
    assert.deepEqual(stockWrites[0], stockWrites[1]);
    await page.unroute("**/api/ecommerce/operations");
    await stock.getByRole("button", { name: "Done", exact: true }).click();
    for (const v of values) {
      const q = (await read("_ecommerce_stocks", `stock_${v.id}`)).quantity;
      assert.equal(
        q,
        v.value === "XS / Navy"
          ? 1
          : v.value.endsWith("Navy")
            ? v.value.startsWith("7XL")
              ? 5
              : 4
            : before.some((b) => b.id === v.id)
              ? 1
              : 2,
      );
    }
    assert.equal(
      (await read("_ecommerce_product_variant_values", first.id)).sku,
      `KEEP-${ctx.runId}`,
    );
    assert.equal(
      (await read("_ecommerce_product_variant_values", first.id)).priceOverride,
      5900,
    );
    await page
      .getByRole("button", { name: "Update stock", exact: true })
      .click();
    await stock
      .getByLabel("Add units for XS / Navy", { exact: true })
      .fill("2");
    await stock
      .getByLabel("Reason for this stock update", { exact: true })
      .fill("Concurrent delivery check");
    let conflicted = false;
    await page.route("**/api/ecommerce/operations", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "stocktake" || conflicted) return route.continue();
      conflicted = true;
      const line = body.data.lines.find(
        (line) => line.targetId === `stock_${first.id}`,
      );
      await post("operations", {
        action: "stockMovement",
        data: {
          requestKey: crypto.randomUUID(),
          targetType: "stock",
          targetId: line.targetId,
          expectedQuantity: line.expectedQuantity,
          expectedUpdatedAt: line.expectedUpdatedAt,
          kind: "correction",
          delta: -1,
          reason: "Concurrent stock update test",
        },
      });
      return route.continue();
    });
    await stock
      .getByRole("button", { name: "Save stock for 1 variant", exact: true })
      .click();
    await expectVisible(
      stock.getByText(/Stock changed during this count/),
      "concurrent stock edit refused",
    );
    await page.unroute("**/api/ecommerce/operations");
    assert.equal(
      (await read("_ecommerce_stocks", `stock_${first.id}`)).quantity,
      0,
    );
    await stock
      .getByRole("button", {
        name: "Reload variants and review again",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Update stock", exact: true })
      .click();
    await stock
      .getByLabel("Stock update", { exact: true })
      .selectOption("count");
    await stock
      .getByLabel("Counted stock for XS / Navy", { exact: true })
      .fill("6");
    await stock
      .getByLabel("Reason for this stock update", { exact: true })
      .fill("Recount after concurrent stock change");
    await stock
      .getByRole("button", { name: "Save stock for 1 variant", exact: true })
      .click();
    await expectVisible(
      stock.getByText("Stock updated for 1 variant with staff history.", {
        exact: true,
      }),
      "fresh count confirmed",
    );
    assert.equal(
      (await read("_ecommerce_stocks", `stock_${first.id}`)).quantity,
      6,
    );
    await stock.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await page
      .getByRole("link", { name: "Variants & inventory", exact: true })
      .click();
    await page
      .getByLabel("Filter by colour", { exact: true })
      .selectOption("Olive");
    await expectVisible(
      page.getByText("Showing 11 of 55 variants", { exact: true }),
      "saved variants survive reload",
    );
    await page
      .getByLabel("Find a variant", { exact: true })
      .fill("no-such-size");
    await expectVisible(
      page.getByText(
        "No variants match these filters. Clear the filters to see every size and colour.",
        { exact: true },
      ),
      "empty search recovery",
    );
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expectVisible(
      page.getByText("Showing 55 of 55 variants", { exact: true }),
      "clear filters restores list",
    );
    await page
      .getByRole("button", { name: "Make image 2 the main image", exact: true })
      .click();
    await page.getByLabel("Visibility", { exact: true }).selectOption("active");
    await page
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await waitUntil("product image and visibility saved", async () => {
      const p = await read("products", productId);
      return p.status === "active" && p.images[0] === photo;
    });
    const shop = await ctx.admin.context.newPage();
    try {
      await shop.goto(`/shop/${productId}`);
      await shop
        .getByRole("button", { name: "Size / Colour: XS / Navy", exact: true })
        .click();
      await expectVisible(
        shop.locator("[data-product-stock]").filter({ hasText: "6 available" }),
        "storefront receives recounted stock",
      );
      assert.equal(
        await shop.locator("#product-hero-image").getAttribute("src"),
        photo,
      );
      await expectVisible(
        shop.locator("[data-product-price]").filter({ hasText: "59.00" }),
        "existing custom price kept",
      );
      await shop
        .getByRole("button", {
          name: "Size / Colour: 7XL / Olive",
          exact: true,
        })
        .click();
      await expectVisible(
        shop.locator("[data-product-stock]").filter({ hasText: "2 available" }),
        "new combination is purchasable",
      );
      assert.equal(
        await shop.locator("#product-hero-image").getAttribute("src"),
        photo,
      );
    } finally {
      await shop.close();
      const latest = await read("products", productId);
      const restored = await page.request.put(
        `/admin/api/collections/products/entries/${productId}`,
        {
          headers: { Origin: origin },
          data: {
            data: { status: "draft" },
            expectedUpdatedAt: latest.updatedAt,
          },
        },
      );
      assert.ok(restored.ok());
    }
    return `Product ${productId}: 40 → 55 variants in the same set; colour photos, selected stock, hidden selections, retry recovery, metadata preservation, reload and mobile accessibility verified.`;
  } catch (error) {
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/existing-product-failure.png`,
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await page.close();
  }
}
