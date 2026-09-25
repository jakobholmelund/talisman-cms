import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import ts from 'typescript';
import { ecommercePlugin } from '../dist/index.js';
import * as schema from '../dist/schema.js';

// The core refuses a native write to a table column that is not a configured field, so every key
// the admin sends to a commerce collection must be one. The keys are read from the admin source.
const adminUi = new URL('../../talisman-cms/ui/', import.meta.url);
const entryEditorPath = 'routes/collections/$slug/$entryId.tsx';
const commerceModelsPath = 'lib/commerce-models.ts';
const pageBuilderPath = 'lib/page-builder.ts';

// The server sets these itself and drops them from a write.
const serverManagedColumns = ['createdAt', 'updatedAt'];

function parseAdminSource(path) {
  const text = readFileSync(new URL(path, adminUi), 'utf8');
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
  assert.ok(slugs, `${commerceModelsPath} no longer declares COMMERCE_FLOW_SLUGS`);
  return slugs;
}

/** buildDefaultValues from the admin source: the values the collection form starts a new record with. */
function loadFormDefaults() {
  const sourceFile = parseAdminSource(pageBuilderPath);
  const names = ['isRelationshipFieldType', 'createDefaultValueForField', 'buildDefaultValues'];
  const declarations = sourceFile.statements
    .filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
  assert.equal(declarations.length, names.length, `${pageBuilderPath} no longer declares ${names.join(', ')}`);
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
  for (const slug of ['_ecommerce_variants', '_ecommerce_product_variants', '_ecommerce_product_variant_values', '_ecommerce_stocks']) {
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
  assert.deepEqual(groups.fields.find((field) => field.name === 'inventoryQuantity'),
    { name: 'inventoryQuantity', label: 'Inventory Quantity', type: 'number', defaultValue: 0 });
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
