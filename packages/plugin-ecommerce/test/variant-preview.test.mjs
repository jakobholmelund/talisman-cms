import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModule, pluginAdmin } from './helpers/admin-source.mjs';
const { buildVariantPreview } = await import(compileModule(new URL('variant-preview.ts', pluginAdmin)));
const value = {localId:'v',id:'v',value:'Small',sku:'S',image:'',priceOverride:'',stockId:'s',stockQuantity:'0'};
const group = {localId:'g',id:'g',variantId:'d',name:'Size',sku:'',priceOverride:'',inventoryQuantity:'9',values:[value]};
test('blank overrides inherit product or group price, and explicit zero stock stays zero', () => {
  const result = buildVariantPreview({basePrice:12900},[group],{});
  assert.equal(result.selected.priceCents,12900); assert.equal(result.selected.quantity,0); assert.equal(result.available(result.selected),false);
  assert.equal(buildVariantPreview({basePrice:12900},[{...group,priceOverride:'900'}],{}).selected.priceCents,900);
});
test('recipes override choice stock, while missing stock falls back to its group', () => {
  const rows = {_ecommerce_variant_components:[{id:'r',data:{productVariantValueId:'v',componentId:'c',quantity:2}}],_ecommerce_components:[{id:'c',data:{quantity:7}}]};
  assert.equal(buildVariantPreview({basePrice:100},[group],rows).selected.quantity,3);
  assert.equal(buildVariantPreview({basePrice:100},[{...group,values:[{...value,stockId:null}]}],{}).selected.quantity,9);
});
test('legacy options and digital subscriptions preview availability without inventing free prices', () => {
  assert.equal(buildVariantPreview({basePrice:100},[{...group,values:[]}],{}).selected.quantity,9);
  for(const type of ['digital','subscription']) {
    const result=buildVariantPreview({basePrice:100,type},[group],{});
    assert.equal(result.selected.quantity,null); assert.equal(result.available(result.selected),true);
  }
  const zero=buildVariantPreview({basePrice:0,type:'digital'},[group],{});
  assert.equal(zero.available(zero.selected),false);
});
