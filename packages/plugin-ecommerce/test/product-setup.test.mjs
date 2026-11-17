import test from "node:test";
import assert from "node:assert/strict";
import { compileModule, pluginAdmin } from "./helpers/admin-source.mjs";
const { finishProductSetup } = await import(
  compileModule(new URL("product-setup.ts", pluginAdmin))
);
const plan = () => ({
  create: {
    action: "createOptionSet",
    productId: "shirt",
    requestKey: "setup-request",
    name: "Size / Colour",
    values: ["Small / Blue", "Large / Blue"],
    images: ["/blue.png", "/blue.png"],
  },
  quantities: [4, 8],
});
const snapshot = () => ({
  rows: [0, 1].map((index) => ({
    type: "stock",
    id: `stock_group_${index}`,
    quantity: 0,
    updatedAt: "2026-11-17T00:00:00.000Z",
  })),
});
test("lost stock response resumes the same receipt without rereading versions or creating more variants", async () => {
  const state = plan(),
    calls = [];
  let lost = true;
  const request = async (path, body) => {
    calls.push(structuredClone({ path, body }));
    if (path === "variants") return { result: { groupId: "group" } };
    if (body.action === "stocktakeRead") return snapshot();
    if (lost) {
      lost = false;
      throw new Error("Response lost after commit");
    }
    return { result: { stocktakeId: "count" } };
  };
  await assert.rejects(finishProductSetup(state, request), /Response lost/);
  assert.equal(state.groupId, "group");
  assert.equal(state.complete, undefined);
  await finishProductSetup(state, request);
  await finishProductSetup(state, request);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], calls[3]);
  assert.equal(state.complete, true);
  assert.deepEqual(
    calls[2].body.data.lines.map((line) => line.countedQuantity),
    [4, 8],
  );
});
test("lost variant response retries the same create key before recording stock", async () => {
  const state = plan(),
    calls = [];
  let lost = true;
  const request = async (path, body) => {
    calls.push(structuredClone({ path, body }));
    if (path === "variants") {
      if (lost) {
        lost = false;
        throw new Error("Lost");
      }
      return { result: { groupId: "group" } };
    }
    return body.action === "stocktakeRead"
      ? snapshot()
      : { result: { stocktakeId: "count" } };
  };
  await assert.rejects(finishProductSetup(state, request));
  await finishProductSetup(state, request);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls.filter((c) => c.body.action === "stocktake").length, 1);
});
test("changed or missing opening stock never gets overwritten", async () => {
  for (const rows of [
    [],
    snapshot().rows.map((row) => ({ ...row, quantity: 2 })),
  ]) {
    const state = plan(),
      writes = [];
    await assert.rejects(
      finishProductSetup(state, async (path, body) => {
        if (path === "variants") return { result: { groupId: "group" } };
        if (body.action === "stocktakeRead") return { rows };
        writes.push(body);
      }),
      /Starting stock could not be confirmed/,
    );
    assert.equal(writes.length, 0);
    assert.equal(state.complete, undefined);
  }
});
test("zero starting stock needs no stock mutation; incomplete receipts cannot finish setup", async () => {
  const zero = plan();
  zero.quantities = [0, 0];
  let calls = 0;
  await finishProductSetup(zero, async () => {
    calls++;
    return { result: { groupId: "group" } };
  });
  assert.equal(calls, 1);
  assert.equal(zero.complete, true);
  const state = plan();
  await assert.rejects(
    finishProductSetup(state, async (path, body) =>
      path === "variants"
        ? { result: { groupId: "group" } }
        : body.action === "stocktakeRead"
          ? snapshot()
          : {},
    ),
    /Could not confirm starting stock/,
  );
  assert.equal(state.complete, undefined);
  assert.ok(state.stockRequest);
});

test('opening stock for additions addresses only the new stock rows, not the original group',async()=>{
 const state=plan();state.create={...state.create,action:'addOptionValues',groupId:'original',expectedUpdatedAt:'2026-11-17T00:00:00.000Z'};
 const calls=[];await finishProductSetup(state,async(path,body)=>{
 calls.push(body);if(path==='variants')return {result:{groupId:'original'}};
 if(body.action==='stocktakeRead')return {rows:body.data.targets.map(target=>({id:target.targetId,type:'stock',quantity:0,updatedAt:'2026-11-17T00:00:00.000Z'}))};
 return {result:{stocktakeId:'new-count'}};
 });
 assert.deepEqual(calls[1].data.targets.map(t=>t.targetId),['stock_setup_setup-request_0','stock_setup_setup-request_1']);
});
