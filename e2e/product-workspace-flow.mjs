import axe from "axe-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/** Real local persistence, including an intentionally lost setup response and audited inventory. */
export async function productWorkspaceFlow(
  ctx,
  { expectVisible, expectHidden, expectValue, waitUntil, makePng },
) {
  const page = await ctx.admin.context.newPage();
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.dismiss());
  let product = null;
  const read = async (slug, id) => {
    const r = await page.request.get(
      `/admin/api/collections/${slug}/entries/${id}`,
    );
    assert.ok(r.ok());
    const v = await r.json();
    return v.data ?? v;
  };
  const rows = async (slug, key, id) => {
    const r = await page.request.get(
      `/admin/api/collections/${slug}/entries?where[${key}]=${encodeURIComponent(id)}&limit=100`,
    );
    assert.ok(r.ok());
    return (await r.json()).docs;
  };
  const scan = async (name) => {
    if (!(await page.evaluate(() => Boolean(window.axe))))
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
      engine: result.testEngine,
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
    assert.deepEqual(
      result.incomplete.filter((check) => check.id === "aria-prohibited-attr"),
      [],
      "Setup labels must belong to accessible groups",
    );
  };
  const route = "**/api/ecommerce/variants";
  try {
    await page.goto("/admin/commerce/products/new");
    await expectVisible(
      page.getByRole("heading", { name: "New Product", exact: true }),
      "new product screen",
    );
    await page
      .locator('[data-field-path="name"] input')
      .fill(`Workspace tee ${ctx.runId}`);
    await expectValue(
      page.getByRole("textbox", { name: /URL name/ }),
      `workspace-tee-${ctx.runId}`,
      "URL name follows the product name",
    );
    await page
      .getByRole("textbox", { name: "Price (USD)", exact: true })
      .fill("27.50");
    const gallery = page.locator('[data-field-path="images"]');
    for (const [i, colour] of [
      [1, [40, 70, 180]],
      [2, [180, 70, 40]],
    ]) {
      await gallery.locator("input[type=file]").setInputFiles({
        name: `workspace-${ctx.runId}-${i}.png`,
        mimeType: "image/png",
        buffer: makePng(100, 100, colour),
      });
      await expectVisible(
        gallery.getByRole("img", { name: `Product image ${i}`, exact: true }),
        `gallery image ${i}`,
      );
    }
    const alternate = await gallery
      .getByRole("img", { name: "Product image 1", exact: true })
      .getAttribute("src");
    const original = await gallery
      .getByRole("img", { name: "Product image 2", exact: true })
      .getAttribute("src");
    await gallery
      .getByRole("button", { name: "Make image 2 the main image", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create product", exact: true })
      .click();
    await page.waitForURL(
      (url) =>
        /\/commerce\/products\/[^/]+$/.test(url.pathname) &&
        !url.pathname.endsWith("/new"),
    );
    product = { id: new URL(page.url()).pathname.split("/").pop() };
    await expectVisible(
      page.getByRole("heading", { name: "Variants & inventory", exact: true }),
      "handoff to variant setup",
    );
    assert.equal(new URL(page.url()).hash, "#commerce-product-options");
    await waitUntil("product price and main image saved", async () => {
      const d = await read("products", product.id);
      return d.basePrice === 2750 && d.images[0] === original;
    });
    await page
      .getByRole("button", { name: "Sell without variants", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manage product inventory", exact: true })
      .click();
    await expectVisible(
      page.getByRole("form", { name: "Stock change", exact: true }),
      "simple product inventory opens",
    );
    await page.getByLabel("Units received", { exact: true }).fill("3");
    await page
      .getByLabel("Reason for stock change", { exact: true })
      .fill("Workspace simple product receipt");
    await page
      .getByRole("button", { name: "Record stock change", exact: true })
      .click();
    await expectVisible(
      page.getByText("Stock change recorded with its staff history.", {
        exact: true,
      }),
      "simple product receipt saved",
    );
    await page
      .getByRole("button", { name: "Close inventory", exact: true })
      .click();
    await page.locator("#commerce-product-preview > summary").click();
    await expectVisible(
      page
        .getByRole("region", { name: "Product preview" })
        .getByText(/3 available/),
      "simple product preview refreshes stock without reloading",
    );

    await page
      .getByText("Add choices or combinations", { exact: true })
      .click();
    const setup = page.getByRole("region", {
      name: "Create product choices",
      exact: true,
    });
    await setup.getByLabel("Sizes", { exact: true }).fill("Small, Medium");
    await setup.getByLabel("Colours", { exact: true }).fill("Blue, Black");
    await scan("product-setup-choices");
    await setup
      .getByRole("button", { name: "Continue to photos & stock", exact: true })
      .click();
    await setup
      .getByRole("button", {
        name: "Use product image 2 for Blue",
        exact: true,
      })
      .click();
    await setup
      .getByLabel("Same stock for every variant", { exact: true })
      .fill("2");
    await setup
      .getByRole("button", { name: "Apply to all", exact: true })
      .click();
    await setup
      .getByLabel("Starting stock for Small / Blue", { exact: true })
      .fill("3");
    await setup
      .getByLabel("Starting stock for Medium / Black", { exact: true })
      .fill("0");
    await scan("product-setup-review");
    const desktopViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil("setup fits mobile", () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await scan("product-setup-mobile");
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/setup-mobile.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize(desktopViewport);
    const stockAttempts = [];
    await page.route("**/api/ecommerce/operations", async (r) => {
      const data = r.request().postDataJSON();
      if (data.action !== "stocktake") return r.continue();
      stockAttempts.push(data);
      if (stockAttempts.length === 1) {
        const response = await r.fetch();
        assert.ok(response.ok(), await response.text());
        return r.abort("failed");
      }
      return r.continue();
    });
    const attempts = [];
    await page.route(route, async (r) => {
      const data = r.request().postDataJSON();
      if (data.action !== "createOptionSet") return r.continue();
      attempts.push(data);
      if (attempts.length === 1) {
        const response = await r.fetch();
        assert.ok(response.ok(), await response.text());
        return r.abort("failed");
      }
      return r.continue();
    });
    await setup
      .getByRole("button", {
        name: "Create 4 variants & save stock",
        exact: true,
      })
      .click();
    await expectVisible(
      setup.getByRole("button", {
        name: "Retry and finish setup",
        exact: true,
      }),
      "ambiguous setup exposes safe retry",
    );
    await setup
      .getByRole("button", { name: "Retry and finish setup", exact: true })
      .click();
    await expectVisible(
      setup
        .getByRole("status")
        .filter({ hasText: "Starting stock still needs confirmation" }),
      "variants saved while stock response is unknown",
    );
    await setup
      .getByRole("button", { name: "Retry and finish setup", exact: true })
      .click();
    await expectVisible(
      setup.getByRole("status").filter({ hasText: "4 variants created" }),
      "setup recovered",
    );
    assert.equal(stockAttempts.length, 2);
    assert.deepEqual(stockAttempts[0], stockAttempts[1]);
    await page.unroute("**/api/ecommerce/operations");
    await setup
      .getByRole("button", { name: "View variants", exact: true })
      .click();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    await page.unroute(route);
    const groups = await rows(
      "_ecommerce_product_variants",
      "productId",
      product.id,
    );
    assert.equal(groups.length, 1);
    const values = await rows(
      "_ecommerce_product_variant_values",
      "productVariantId",
      groups[0].id,
    );
    assert.equal(values.length, 4);
    for (const entry of values) {
      const data = entry.data ?? entry;
      assert.equal(data.image, data.value.endsWith("Blue") ? alternate : null);
    }

    const value = values.find((v) => (v.data ?? v).value === "Small / Blue");
    assert.ok(value);
    const stockRows = await rows(
      "_ecommerce_stocks",
      "productVariantValueId",
      value.id,
    );
    assert.equal(stockRows.length, 1);
    let row = page
      .locator("details.ecom-variant-row")
      .filter({ hasText: "Small / Blue" });
    await row.locator("summary").first().click();
    await row.getByLabel("Price (USD)", { exact: true }).fill("31.755");
    await row
      .getByRole("button", { name: "Save variant", exact: true })
      .click();
    await expectVisible(
      page.getByRole("alert").filter({ hasText: "Enter a positive price" }),
      "invalid currency precision refused",
    );
    await row.getByLabel("Price (USD)", { exact: true }).fill("31.75");
    await row.locator(".ecom-product-option-image > summary").click();
    await row
      .getByRole("button", {
        name: "Browse for Variant Image of Small / Blue",
        exact: true,
      })
      .click();
    await row
      .getByRole("region", { name: "Media library", exact: true })
      .getByRole("button", { name: new RegExp(`workspace-${ctx.runId}-1`) })
      .click();
    await row
      .getByRole("button", { name: "Save variant", exact: true })
      .click();
    await waitUntil(
      "variant price stored in minor units",
      async () =>
        (await read("_ecommerce_product_variant_values", value.id))
          .priceOverride === 3175,
    );
    await row
      .getByRole("button", { name: "Manage inventory", exact: true })
      .click();
    await page.getByLabel("Units received", { exact: true }).fill("5");
    await page
      .getByLabel("Reason for stock change", { exact: true })
      .fill("Workspace variant receipt");
    await page
      .getByRole("button", { name: "Record stock change", exact: true })
      .click();
    await expectVisible(
      page.getByText("Stock change recorded with its staff history.", {
        exact: true,
      }),
      "variant receipt saved",
    );
    await expectVisible(
      row.locator("summary").getByText("8 available", { exact: true }),
      "variant summary refreshes immediately",
    );
    await expectVisible(
      page
        .getByRole("region", { name: "Stock movement history" })
        .getByText(/Workspace variant receipt/),
      "audited movement appears",
    );
    await page
      .getByRole("button", { name: "Close inventory", exact: true })
      .click();
    await row
      .getByLabel("SKU (optional)", { exact: true })
      .fill(`BLUE-${ctx.runId}`);
    await row
      .getByRole("button", { name: "Save variant", exact: true })
      .click();
    await waitUntil(
      "variant metadata saved",
      async () =>
        (await read("_ecommerce_product_variant_values", value.id)).sku ===
        `BLUE-${ctx.runId}`,
    );
    assert.equal(
      (await read("_ecommerce_stocks", stockRows[0].id)).quantity,
      8,
    );
    assert.equal(
      (await read("_ecommerce_product_variant_values", value.id)).image,
      alternate,
    );
    await waitUntil("variant save completed in the editor", () =>
      row
        .getByRole("button", { name: "Save variant", exact: true })
        .isEnabled(),
    );
    await page.reload();
    await expectVisible(
      page.getByRole("heading", { name: "Variants & inventory", exact: true }),
      "reloaded product",
    );
    row = page
      .locator("details.ecom-variant-row")
      .filter({ hasText: "Small / Blue" });
    await expectVisible(
      row.locator("summary").getByText("$31.75", { exact: true }),
      "variant price persisted",
    );
    await expectVisible(
      row.locator("summary").getByText("8 available", { exact: true }),
      "variant inventory persisted",
    );
    assert.equal(
      await gallery
        .getByRole("img", { name: "Product image 1", exact: true })
        .getAttribute("src"),
      original,
    );
    assert.equal(
      await row.locator("summary img").getAttribute("src"),
      alternate,
    );
    await row.locator("summary").first().press("Enter");
    await expectVisible(
      row.getByLabel("Choice name", { exact: true }),
      "variant opens from keyboard",
    );
    await scan("product-workspace");
    await row.locator("summary").first().press("Enter");
    await page
      .getByRole("link", { name: "Variants & inventory", exact: true })
      .click();
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/product-workspace-desktop.png`,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil("responsive layout fits", () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    if (ctx.options.artifacts)
      await page.screenshot({
        path: `${ctx.options.artifacts}/product-workspace-mobile.png`,
        fullPage: true,
      });
    assert.equal((await page.request.get(`/shop/${product.id}`)).status(), 404);
    await page.getByLabel("Visibility", { exact: true }).selectOption("active");
    await page
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await waitUntil(
      "product made available",
      async () => (await read("products", product.id)).status === "active",
    );
    const shop = await ctx.admin.context.newPage();
    try {
      await shop.goto(`/shop/${product.id}`);
      await shop
        .getByRole("button", {
          name: "Size / Colour: Small / Blue",
          exact: true,
        })
        .click();
      await expectVisible(
        shop.locator("[data-product-stock]").filter({ hasText: "8 available" }),
        "storefront receives stock",
      );
      assert.equal(
        await shop.locator("#product-hero-image").getAttribute("src"),
        alternate,
      );
      await shop
        .getByRole("button", {
          name: "Size / Colour: Medium / Black Sold out",
          exact: true,
        })
        .click();
      assert.equal(
        await shop.locator("#product-hero-image").getAttribute("src"),
        original,
      );
      assert.ok(await shop.locator(".product__add").isDisabled());
    } finally {
      await shop.close();
      const latest = await read("products", product.id);
      const restored = await page.request.put(
        `/admin/api/collections/products/entries/${product.id}`,
        {
          data: {
            data: { status: "draft" },
            expectedUpdatedAt: latest.updatedAt,
          },
          headers: { Origin: ctx.options.baseUrl },
        },
      );
      assert.ok(restored.ok(), "test product restored to draft");
    }
    return `Product ${product.id}: gallery upload/reorder, currency editing, simple stock, four combinations, lost-response recovery, variant price, receipt, history and persistence pass on desktop/mobile.`;
  } catch (error) {
    console.log(
      "Workspace saved data:",
      JSON.stringify(product ? await read("products", product.id) : null),
    );
    if (ctx.options.artifacts)
      await page.screenshot({
        path: `${ctx.options.artifacts}/product-workspace-failure.png`,
        fullPage: true,
      });
    throw error;
  } finally {
    await page.unroute(route);
    await page.unroute("**/api/ecommerce/operations");
    await page.close();
  }
}
