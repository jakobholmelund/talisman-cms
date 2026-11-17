import assert from "node:assert/strict";
import axe from "axe-core";
import { mkdir } from "node:fs/promises";

/** Catalogue-wide discovery and real persistence, including lost responses and concurrent edits. */
export async function catalogueFlow(
  ctx,
  { expectVisible, waitUntil, makePng },
) {
  const page = await ctx.admin.context.newPage();
  page.on("dialog", (d) => d.dismiss());
  const origin = ctx.options.baseUrl,
    prefix = `Catalogue ${ctx.runId}`,
    ids = [];
  const name = (n) => `${prefix} item ${String(n).padStart(2, "0")}`;
  const api = async (path, data) => {
    const response = await page.request.post(`/admin/api/ecommerce/${path}`, {
      headers: { Origin: origin },
      data,
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const read = async (id, slug = "products") => {
    const response = await page.request.get(
      `/admin/api/collections/${slug}/entries/${id}`,
    );
    assert.ok(response.ok());
    const value = await response.json();
    return value.data ?? value;
  };
  const patch = async (id, data) => {
    const current = await read(id);
    const response = await page.request.put(
      `/admin/api/collections/products/entries/${id}`,
      {
        headers: { Origin: origin },
        data: { data, expectedUpdatedAt: current.updatedAt },
      },
    );
    assert.ok(response.ok(), await response.text());
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
  const result = (total, p) =>
    page.getByText(
      `${total} product${total === 1 ? "" : "s"} · Page ${p} of ${Math.max(1, Math.ceil(total / 25))}`,
      { exact: true },
    );
  const search = async (value, total, p = 1) => {
    await page.getByRole("searchbox", { name: "Find products" }).fill(value);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expectVisible(result(total, p), "search results");
  };
  try {
    await page.goto("/admin/commerce/products/new");
    await page.locator("[data-field-path=name] input").fill(name(0));
    await page
      .getByRole("textbox", { name: "Price (USD)", exact: true })
      .fill("10");
    const gallery = page.locator("[data-field-path=images]");
    await gallery.locator("input[type=file]").setInputFiles({
      name: `catalogue-${ctx.runId}.png`,
      mimeType: "image/png",
      buffer: makePng(100, 100, [70, 110, 85]),
    });
    await expectVisible(
      gallery.getByRole("img", { name: "Product image 1", exact: true }),
      "fixture image",
    );
    const photo = await gallery
      .getByRole("img", { name: "Product image 1", exact: true })
      .getAttribute("src");
    await page
      .getByRole("button", { name: "Create product", exact: true })
      .click();
    await page.waitForURL(
      (u) =>
        /\/commerce\/products\/[^/]+$/.test(u.pathname) &&
        !u.pathname.endsWith("/new"),
    );
    ids.push(new URL(page.url()).pathname.split("/").pop());
    for (let n = 1; n < 55; n++) {
      const response = await page.request.post(
        "/admin/api/collections/products/entries",
        {
          headers: { Origin: origin },
          data: {
            data: {
              name: name(n),
              slug: `catalogue-${ctx.runId}-${n}`,
              sku: `CAT-${ctx.runId}-${n}`,
              basePrice: 1000 + n,
              images: n % 2 ? [] : [{ url: photo }],
              status: "draft",
              type: "standard",
            },
          },
        },
      );
      assert.ok(response.ok(), await response.text());
      const body = await response.json();
      ids.push(body.id ?? body.data.id);
    }
    for (let start = 1; start < ids.length; start += 50) {
      const targets = ids
        .slice(start, start + 50)
        .map((targetId) => ({ targetType: "product", targetId }));
      const stock = await api("operations", {
        action: "stocktakeRead",
        data: { targets },
      });
      await api("operations", {
        action: "stocktake",
        data: {
          requestKey: crypto.randomUUID(),
          reason: "Opening catalogue product inventory",
          lines: stock.rows.map((v) => ({
            targetType: "product",
            targetId: v.id,
            expectedQuantity: v.quantity,
            expectedUpdatedAt: v.updatedAt,
            countedQuantity:
              ids.indexOf(v.id) % 3 === 0
                ? 0
                : ids.indexOf(v.id) % 3 === 1
                  ? 3
                  : 20,
          })),
        },
      });
    }
    const {
      result: { groupId },
    } = await api("variants", {
      action: "createOptionSet",
      productId: ids[0],
      requestKey: crypto.randomUUID(),
      name: "Edition",
      values: ["Regular", "Special"],
    });
    const response = await page.request.get(
      `/admin/api/collections/_ecommerce_product_variant_values/entries?where[productVariantId]=${groupId}&limit=100`,
    );
    const values = (await response.json()).docs.map((v) => ({
      id: v.id,
      ...(v.data ?? v),
    }));
    const special = values.find((v) => v.value === "Special");
    await api("variants", {
      action: "saveValue",
      groupId,
      value: {
        id: special.id,
        expectedUpdatedAt: special.updatedAt,
        value: special.value,
        sku: `SPECIAL-${ctx.runId}`,
        image: null,
        priceOverride: 3333,
      },
    });
    const snapshot = await api("operations", {
      action: "stocktakeRead",
      data: {
        targets: values.map((v) => ({
          targetType: "stock",
          targetId: `stock_${v.id}`,
        })),
      },
    });
    await api("operations", {
      action: "stocktake",
      data: {
        requestKey: crypto.randomUUID(),
        reason: "Opening catalogue test inventory",
        lines: snapshot.rows.map((v) => ({
          targetType: "stock",
          targetId: v.id,
          expectedQuantity: v.quantity,
          expectedUpdatedAt: v.updatedAt,
          countedQuantity: 5,
        })),
      },
    });

    await page.goto("/admin/commerce/products");
    await search(prefix, 55);
    await page
      .getByLabel("Sort catalogue", { exact: true })
      .selectOption("name");
    await expectVisible(
      page.getByRole("checkbox", { name: `Select ${name(0)}`, exact: true }),
      "name sort",
    );
    await page
      .getByRole("button", { name: "Missing images 27", exact: true })
      .click();
    await expectVisible(
      result(27, 1),
      "attention is computed across every page",
    );
    await page
      .getByRole("button", { name: "All products 55", exact: true })
      .click();
    await search(`SPECIAL-${ctx.runId}`, 1);
    await expectVisible(
      page.getByRole("link", { name: name(0), exact: false }).first(),
      "variant SKU finds parent",
    );
    await search(prefix, 55);
    await page
      .getByRole("checkbox", { name: `Select ${name(0)}`, exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: `Select ${name(1)}`, exact: true })
      .check();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectVisible(result(55, 2), "second page");
    await page
      .getByRole("checkbox", { name: `Select ${name(25)}`, exact: true })
      .check();
    await expectVisible(
      page.getByText("3 selected · 2 on other pages or hidden by filters", {
        exact: true,
      }),
      "cross-page selection is explicit",
    );
    await scan("catalogue-desktop");
    await page
      .getByRole("button", { name: "Update prices", exact: true })
      .click();
    let review = page.getByRole("region", {
      name: "Review bulk prices",
      exact: true,
    });
    await review
      .getByLabel("Price change", { exact: true })
      .selectOption("increase");
    await review.getByLabel("Percentage", { exact: true }).fill("10");
    await expectVisible(
      review.getByText("$11.00 – $33.33", { exact: true }),
      "preview preserves custom variant price",
    );
    await scan("catalogue-price-preview");
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil("bulk review fits mobile", () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await scan("catalogue-price-preview-mobile");
    await page.setViewportSize(desktop);
    const attempts = [];
    await page.route("**/api/ecommerce/operations", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "catalogueUpdate") return route.continue();
      attempts.push(body);
      if (attempts.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), await response.text());
        return route.abort("failed");
      }
      return route.continue();
    });
    await review
      .getByRole("button", { name: "Save prices for 3 products", exact: true })
      .click();
    await expectVisible(
      review.getByRole("button", { name: "Recover same request", exact: true }),
      "lost response can be recovered",
    );
    await review
      .getByRole("button", { name: "Recover same request", exact: true })
      .click();
    await expectVisible(
      review.getByText("Prices saved for 3 products.", { exact: true }),
      "recovered prices",
    );
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(attempts.length, 2);
    for (const n of [0, 1, 25])
      assert.equal(
        (await read(ids[n])).basePrice,
        Math.round((1000 + n) * 1.1),
      );
    assert.equal(
      (await read(special.id, "_ecommerce_product_variant_values"))
        .priceOverride,
      3333,
    );
    await page.unroute("**/api/ecommerce/operations");
    await review.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Update visibility", exact: true })
      .click();
    review = page.getByRole("region", {
      name: "Review bulk visibility",
      exact: true,
    });
    await review
      .getByLabel("New visibility", { exact: true })
      .selectOption("active");
    await expectVisible(
      review.getByText(/2 without a product image/),
      "missing images warned before publishing",
    );
    await scan("catalogue-visibility-preview");
    await review
      .getByRole("button", {
        name: "Save visibility for 3 products",
        exact: true,
      })
      .click();
    await expectVisible(
      review.getByText("Visibility saved for 3 products.", { exact: true }),
      "availability saved",
    );
    await review.getByRole("button", { name: "Done", exact: true }).click();
    const shop = await ctx.admin.context.newPage();
    try {
      await shop.goto(`/shop/${ids[0]}`);
      await shop
        .getByRole("button", { name: "Edition: Regular", exact: true })
        .click();
      await expectVisible(
        shop.locator("[data-product-price]").filter({ hasText: "$11.00" }),
        "storefront inherits bulk price",
      );
      await shop
        .getByRole("button", { name: "Edition: Special", exact: true })
        .click();
      await expectVisible(
        shop.locator("[data-product-price]").filter({ hasText: "$33.33" }),
        "custom price preserved on storefront",
      );
    } finally {
      await shop.close();
    }
    await page
      .getByRole("button", { name: "Update prices", exact: true })
      .click();
    review = page.getByRole("region", {
      name: "Review bulk prices",
      exact: true,
    });
    await review.getByLabel("New base price (USD)", { exact: true }).fill("40");
    let conflict = false;
    await page.route("**/api/ecommerce/operations", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "catalogueUpdate" && !conflict) {
        conflict = true;
        await patch(ids[0], { description: "A concurrent merchant edit" });
      }
      await route.continue();
    });
    await review
      .getByRole("button", { name: "Save prices for 3 products", exact: true })
      .click();
    await expectVisible(
      review.getByRole("button", {
        name: "Reload selected products",
        exact: true,
      }),
      "concurrent edit requires a fresh review",
    );
    assert.equal(
      (await read(ids[1])).basePrice,
      1101,
      "conflict rolls the entire batch back",
    );
    await review
      .getByRole("button", { name: "Reload selected products", exact: true })
      .click();
    await waitUntil("fresh selection ready", () =>
      review
        .getByRole("button", {
          name: "Save prices for 3 products",
          exact: true,
        })
        .isEnabled(),
    );
    await review
      .getByRole("button", { name: "Save prices for 3 products", exact: true })
      .click();
    await expectVisible(
      review.getByText("Prices saved for 3 products.", { exact: true }),
      "reviewed conflict resolved",
    );
    await page.unroute("**/api/ecommerce/operations");
    await review.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await expectVisible(result(55, 1), "return to page one");
    await page
      .getByRole("checkbox", { name: "Select this page", exact: true })
      .check();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectVisible(result(55, 2), "page two selection");
    await page
      .getByRole("checkbox", { name: "Select this page", exact: true })
      .check();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expectVisible(result(55, 3), "page three");
    assert.ok(
      await page
        .getByRole("checkbox", { name: "Select this page", exact: true })
        .isDisabled(),
      "bounded selection prevents hidden oversized requests",
    );
    await page
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await page
      .getByRole("link", { name: new RegExp(name(50)) })
      .first()
      .click();
    await expectVisible(
      page.getByRole("heading", { name: "Variants & inventory", exact: true }),
      "product editor connected",
    );
    await page.getByRole("link", { name: /Back to Products/ }).click();
    await expectVisible(
      result(55, 3),
      "return preserves search, sorting and page",
    );
    let failRefresh = true;
    await page.route("**/api/ecommerce/operations?*", (route) =>
      failRefresh
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Catalogue temporarily unavailable",
            }),
          })
        : route.continue(),
    );
    await page
      .getByRole("button", { name: "Refresh catalogue", exact: true })
      .click();
    await expectVisible(
      page
        .getByRole("alert")
        .filter({ hasText: "Displayed products may be out of date" }),
      "stale catalogue clearly identified",
    );
    assert.ok(
      await page
        .getByRole("checkbox", { name: "Select this page", exact: true })
        .isDisabled(),
    );
    failRefresh = false;
    await page
      .getByRole("button", { name: "Refresh catalogue", exact: true })
      .click();
    await waitUntil("catalogue recovers", () =>
      page
        .getByRole("checkbox", { name: "Select this page", exact: true })
        .isEnabled(),
    );
    await page.unroute("**/api/ecommerce/operations?*");
    await page.setViewportSize({ width: 390, height: 844 });
    await waitUntil("catalogue fits mobile", () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await scan("catalogue-mobile");
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/catalogue-mobile.png`,
        fullPage: true,
      });
    }
    return "55 products: catalogue-wide attention and variant search, paging, persistent filters, cross-page selection, 50-product limit, price/visibility reviews, lost-response recovery, atomic conflict handling, storefront prices and desktop/mobile accessibility pass.";
  } catch (error) {
    if (ctx.options.artifacts) {
      await mkdir(ctx.options.artifacts, { recursive: true });
      await page.screenshot({
        path: `${ctx.options.artifacts}/catalogue-failure.png`,
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await page.unroute("**/api/ecommerce/operations");
    await page.unroute("**/api/ecommerce/operations?*");
    for (const n of [0, 1, 25])
      if (ids[n]) await patch(ids[n], { status: "draft" });
    await page.close();
  }
}
