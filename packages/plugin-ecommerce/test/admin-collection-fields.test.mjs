import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import ts from 'typescript';
import { ecommercePlugin } from '../dist/index.js';
import * as schema from '../dist/schema.js';
import { variantChangeSchema } from '../dist/variants.js';

// The core refuses a native write to a table column that is not a configured field, so every key
// the admin sends to a commerce collection must be one. Variant values and their stock go to the
// plugin's variants endpoint instead, which refuses keys it does not know. The keys are read from the
// admin source: the plugin's Options & stock panel and describer, and the core's form defaults.
const pluginAdmin = new URL('../src/admin/', import.meta.url);
const coreUi = new URL('../../talisman-cms/ui/', import.meta.url);
const entryEditorPath = new URL('ProductOptionsPanel.tsx', pluginAdmin);
const commerceModelsPath = new URL('commerce-models.ts', pluginAdmin);
const pageBuilderPath = new URL('lib/page-builder.ts', coreUi);

// The server sets these itself and drops them from a write.
const serverManagedColumns = ['createdAt', 'updatedAt'];

function parseAdminSource(url) {
  const path = url.pathname;
  const text = readFileSync(url, 'utf8');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function where(sourceFile, node) {
  return `${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

/** The expression a node stands for, following a `const` in an enclosing block to its initializer. */
function resolve(sourceFile, node) {
  node = unwrap(node);
  if (!ts.isIdentifier(node)) return node;
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const declaration = statement.declarationList.declarations
        .find((item) => ts.isIdentifier(item.name) && item.name.text === node.text && item.initializer);
      if (declaration) return resolve(sourceFile, declaration.initializer);
    }
  }
  assert.fail(`${where(sourceFile, node)}: ${node.text} is not a const in scope, so the keys it holds cannot be read`);
}

function propertyName(sourceFile, property) {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
  assert.fail(`${where(sourceFile, property)}: cannot read a computed key; list it here so the check keeps covering it`);
}

/** Every key an object literal can have, following spreads of object literals and conditionals. */
function objectLiteralKeys(sourceFile, node) {
  node = resolve(sourceFile, node);
  if (ts.isConditionalExpression(node)) {
    return [...objectLiteralKeys(sourceFile, node.whenTrue), ...objectLiteralKeys(sourceFile, node.whenFalse)];
  }
  assert.ok(ts.isObjectLiteralExpression(node),
    `${where(sourceFile, node)}: the data sent is not an object literal, so its keys cannot be checked`);
  return node.properties.flatMap((property) => ts.isSpreadAssignment(property)
    ? objectLiteralKeys(sourceFile, property.expression)
    : [propertyName(sourceFile, property)]);
}

/** The initializers of a property called `name`, following spreads of object literals and conditionals. */
function propertyValues(sourceFile, node, name) {
  node = resolve(sourceFile, node);
  if (ts.isConditionalExpression(node)) {
    return [...propertyValues(sourceFile, node.whenTrue, name), ...propertyValues(sourceFile, node.whenFalse, name)];
  }
  assert.ok(ts.isObjectLiteralExpression(node),
    `${where(sourceFile, node)}: the data sent is not an object literal, so its keys cannot be checked`);
  return node.properties.flatMap((property) => ts.isSpreadAssignment(property)
    ? propertyValues(sourceFile, property.expression, name)
    : ts.isPropertyAssignment(property) && propertyName(sourceFile, property) === name ? [property.initializer] : []);
}

/** The action and keys of each change the variant editor sends with sendVariantChange(key, change, messages). */
function readVariantChanges() {
  const sourceFile = parseAdminSource(entryEditorPath);
  const changes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sendVariantChange') {
      const change = node.arguments[1];
      assert.ok(change, `${where(sourceFile, node)}: the change is missing`);
      const [action, ...more] = propertyValues(sourceFile, change, 'action');
      assert.ok(action && ts.isStringLiteralLike(action) && !more.length,
        `${where(sourceFile, node)}: name the action once, with a string literal`);
      const nestedKeys = (name) => [...new Set(propertyValues(sourceFile, change, name)
        .flatMap((value) => objectLiteralKeys(sourceFile, value)))];
      changes.push({ action: action.text, keys: [...new Set(objectLiteralKeys(sourceFile, change))],
        value: nestedKeys('value'), stock: nestedKeys('stock'), at: where(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return changes;
}

/** The collection and `data` keys of each requestCollection(slug, method, payload) call that writes. */
function readConfiguratorWrites() {
  const sourceFile = parseAdminSource(entryEditorPath);
  const writes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'requestCollection') {
      const [slug, , payload] = node.arguments;
      assert.ok(slug && ts.isStringLiteralLike(slug), `${where(sourceFile, node)}: name the collection with a string literal`);
      const sendsPayload = payload && !(ts.isIdentifier(payload) && payload.text === 'undefined');
      if (sendsPayload) {
        const body = resolve(sourceFile, payload);
        assert.ok(ts.isObjectLiteralExpression(body), `${where(sourceFile, payload)}: the payload is not an object literal`);
        const data = body.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(sourceFile, property) === 'data');
        assert.ok(data, `${where(sourceFile, payload)}: the payload has no data property`);
        writes.push({ slug: slug.text, keys: [...new Set(objectLiteralKeys(sourceFile, data.initializer))], at: where(sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writes;
}

/** The collections the admin opens in the commerce product flow (COMMERCE_FLOW_SLUGS). */
function readCommerceFlowSlugs() {
  const sourceFile = parseAdminSource(commerceModelsPath);
  let slugs;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'COMMERCE_FLOW_SLUGS') {
      const list = unwrap(node.initializer);
      assert.ok(ts.isArrayLiteralExpression(list) && list.elements.every(ts.isStringLiteralLike),
        `${where(sourceFile, node)}: COMMERCE_FLOW_SLUGS is not a list of string literals`);
      slugs = list.elements.map((element) => element.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(slugs, `${commerceModelsPath.pathname} no longer declares COMMERCE_FLOW_SLUGS`);
  return slugs;
}

/** buildDefaultValues from the admin source: the values the collection form starts a new record with. */
function loadFormDefaults() {
  const sourceFile = parseAdminSource(pageBuilderPath);
  const names = ['isRelationshipFieldType', 'createDefaultValueForField', 'buildDefaultValues'];
  const declarations = sourceFile.statements
    .filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
  assert.equal(declarations.length, names.length, `${pageBuilderPath.pathname} no longer declares ${names.join(', ')}`);
  const source = declarations.map((declaration) => declaration.getText(sourceFile).replace(/^export\s+/, '')).join('\n');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return new Function(`${outputText}\nreturn buildDefaultValues;`)();
}

function injectedCollection(slug) {
  const collection = ecommercePlugin().onInit({ collections: [] }).collections.find((item) => item.slug === slug);
  assert.ok(collection, `the plugin does not inject a ${slug} collection`);
  const table = schema[collection.nativeSchemaMapping?.exportName];
  assert.ok(table, `${slug} does not map to a table in the plugin schema`);
  const columns = getTableColumns(table);
  const fieldNames = new Set(collection.fields.map((field) => field.name));
  // The core accepts a field named after either the column property or the SQL column.
  const isField = (property) => fieldNames.has(property) || fieldNames.has(columns[property]?.name);
  return { collection, columns, isField };
}

test('every key the variant editor sends to a commerce collection is a configured field', () => {
  const writes = readConfiguratorWrites();
  const written = new Set(writes.map((write) => write.slug));
  for (const slug of ['_ecommerce_variants', '_ecommerce_product_variants']) {
    assert.ok(written.has(slug), `the variant editor no longer writes ${slug} through requestCollection; update this test to follow it`);
  }

  for (const { slug, keys, at } of writes) {
    const { collection, columns, isField } = injectedCollection(slug);
    assert.ok(keys.length > 0, `${at}: no keys were read from the write to ${slug}`);
    for (const key of keys) {
      assert.ok(Object.hasOwn(columns, key), `${at}: ${slug}.${key} is not a table column, so the save would drop it`);
      assert.ok(isField(key) || serverManagedColumns.includes(key) || key === collection.nativeSchemaMapping.idColumn,
        `${at}: ${slug}.${key} is not a configured field of ${collection.name}, so the CMS refuses the save`);
    }
  }

  // A group save sends these, inventoryQuantity through a conditional spread, so the reading above follows spreads.
  const groupWrite = writes.find((write) => write.slug === '_ecommerce_product_variants');
  for (const key of ['sku', 'priceOverride', 'inventoryQuantity']) {
    assert.ok(groupWrite.keys.includes(key), `the variant group save no longer sends ${key}`);
  }
});

test('every change the variant editor sends to the variants endpoint has the keys the endpoint accepts', () => {
  const changes = readVariantChanges();
  const actions = new Map(variantChangeSchema.options.map((option) => [option.shape.action.value, option.shape]));
  assert.deepEqual([...new Set(changes.map((change) => change.action))].sort(), ['deleteGroup', 'deleteValue', 'saveValue'],
    'the variant editor no longer sends these changes through sendVariantChange; update this test to follow it');
  const required = (shape) => Object.keys(shape).filter((key) => !shape[key].isOptional());
  const accepts = (shape, keys, what, at) => {
    for (const key of keys) assert.ok(Object.hasOwn(shape, key), `${at}: ${what} does not accept ${key}, so the endpoint refuses the change`);
    for (const key of required(shape)) assert.ok(keys.includes(key), `${at}: ${what} needs ${key}, which the editor does not send`);
  };
  for (const change of changes) {
    const shape = actions.get(change.action);
    assert.ok(shape, `${change.at}: the variants endpoint has no ${change.action} action`);
    accepts(shape, change.keys, change.action, change.at);
  }

  const save = changes.find((change) => change.action === 'saveValue');
  const saveShape = actions.get('saveValue');
  accepts(saveShape.value.shape, save.value, 'a saved value', save.at);
  accepts(saveShape.stock.unwrap().shape, save.stock, 'a saved stock row', save.at);
  // A value save keeps writing the fields the Product Variant Values and Stock Levels screens edit.
  for (const [slug, keys] of [['_ecommerce_product_variant_values', save.value], ['_ecommerce_stocks', save.stock]]) {
    const { collection, columns, isField } = injectedCollection(slug);
    for (const key of keys.filter((key) => !['id', 'expectedUpdatedAt'].includes(key))) {
      assert.ok(Object.hasOwn(columns, key) && isField(key), `${save.at}: ${key} is not a field of ${collection.name}`);
    }
  }
  assert.deepEqual(save.value.sort(), ['expectedUpdatedAt', 'id', 'image', 'priceOverride', 'sku', 'value']);
  assert.deepEqual(save.stock.sort(), ['expectedUpdatedAt', 'id', 'quantity']);
});

test('the commerce collections the admin edits configure every column the server does not set', () => {
  const slugs = readCommerceFlowSlugs();
  for (const slug of ['products', '_ecommerce_variants', '_ecommerce_product_variants', '_ecommerce_product_variant_values', '_ecommerce_stocks']) {
    assert.ok(slugs.includes(slug), `COMMERCE_FLOW_SLUGS no longer lists ${slug}`);
  }

  for (const slug of slugs) {
    const { columns, isField } = injectedCollection(slug);
    const missing = Object.keys(columns).filter((property) => !isField(property) && !serverManagedColumns.includes(property));
    assert.deepEqual(missing, [], `${slug} has table columns the admin cannot write: ${missing.join(', ')}`);
  }

  const groups = injectedCollection('_ecommerce_product_variants').collection;
  // The count is sent only when changed: checkout moves it in place (see saveOnlyIfChanged in the core).
  assert.deepEqual(groups.fields.find((field) => field.name === 'inventoryQuantity'),
    { name: 'inventoryQuantity', label: 'Inventory Quantity', type: 'number', defaultValue: 0, saveOnlyIfChanged: true });
});

test('a new commerce record from the collection form starts its optional fields with values the server keeps', () => {
  const buildDefaultValues = loadFormDefaults();
  for (const slug of readCommerceFlowSlugs()) {
    const { collection, columns } = injectedCollection(slug);
    const defaults = buildDefaultValues(collection.fields);
    for (const field of collection.fields) {
      // The form requires a value for a required field, so only an optional field is saved as it starts.
      if (field.required || defaults[field.name] !== '') continue;
      const column = columns[field.name] ?? Object.values(columns).find((item) => item.name === field.name);
      assert.notEqual(field.type, 'number',
        `${slug}.${field.name} starts as '', which the CMS refuses for a number, so give it a defaultValue`);
      assert.ok(!column?.isUnique,
        `${slug}.${field.name} starts as '', so a second record left blank breaks its UNIQUE column; give it defaultValue: null`);
    }
  }

  const groups = buildDefaultValues(injectedCollection('_ecommerce_product_variants').collection.fields);
  assert.deepEqual({ sku: groups.sku, priceOverride: groups.priceOverride, inventoryQuantity: groups.inventoryQuantity },
    { sku: null, priceOverride: null, inventoryQuantity: 0 });
  const values = buildDefaultValues(injectedCollection('_ecommerce_product_variant_values').collection.fields);
  assert.deepEqual({ sku: values.sku, priceOverride: values.priceOverride }, { sku: null, priceOverride: null });
});
