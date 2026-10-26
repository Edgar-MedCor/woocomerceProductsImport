const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../src/push/plan');
const { writeBack } = require('../src/push/writeback');
const { readWorkbook } = require('../src/excel/reader');
const { TYPE, baseCatalog, mockStore, excelFrom, rowBySku, addRow, syncSheet } = require('./helpers');

const live = (plan) => plan.items.filter((i) => !i.errors.length && i.changes.length);
const itemOf = (plan, sku) => plan.items.find((i) => String(i.data.sku).toUpperCase() === sku.toUpperCase());

test('Excel sin cambios: no hay nada que subir', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const plan = await buildPlan(await excelFrom(catalog));
  assert.equal(live(plan).length, 0);
  assert.equal(plan.summary['Filas con errores (no se suben)'], 0);
});

test('Cambiar precio e inventario de una variación', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  Object.assign(rowBySku(excel, 'RD45747S002'), { regularPrice: 799, stock: 20 });
  const plan = await buildPlan(excel);
  const item = itemOf(plan, 'RD45747S002');
  assert.deepEqual(item.changes.map((c) => c.key).sort(), ['regularPrice', 'stock']);
  assert.equal(live(plan).length, 1);
});

test('Conflicto: alguien cambió el mismo campo directo en la tienda', async () => {
  const catalog = baseCatalog();
  const excel = await excelFrom(catalog);
  const store = baseCatalog();
  store[0].variations_data[0].regular_price = '999'; // cambiado en WordPress después del pull
  mockStore(store);
  rowBySku(excel, 'RD45747S002').regularPrice = 799;
  const plan = await buildPlan(excel);
  const item = itemOf(plan, 'RD45747S002');
  assert.equal(item.changes.length, 0, 'no debe pisar el valor de la tienda');
  assert.equal(item.conflicts.length, 1);
  assert.equal(item.conflicts[0].key, 'regularPrice');
});

test('Cambio en la tienda en OTRO campo no bloquea el cambio del Excel', async () => {
  const catalog = baseCatalog();
  const excel = await excelFrom(catalog);
  const store = baseCatalog();
  store[1].description = 'Editada en WordPress';
  mockStore(store);
  rowBySku(excel, 'BOL48901OS015').regularPrice = 549;
  const plan = await buildPlan(excel);
  const item = itemOf(plan, 'BOL48901OS015');
  assert.deepEqual(item.changes.map((c) => c.key), ['regularPrice']);
  assert.equal(item.conflicts.length, 0);
});

test('Si la tienda ya tiene el valor nuevo, no se vuelve a subir', async () => {
  const catalog = baseCatalog();
  const excel = await excelFrom(catalog);
  const store = baseCatalog();
  store[1].regular_price = '549';
  mockStore(store);
  rowBySku(excel, 'BOL48901OS015').regularPrice = 549;
  const plan = await buildPlan(excel);
  assert.equal(live(plan).length, 0);
});

test('Validaciones: rebajado mayor que normal, inventario no entero, estado inválido', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'BOL48901OS015').salePrice = 600;
  rowBySku(excel, 'RD45747S002').stock = 2.5;
  rowBySku(excel, 'RD45747M002').status = 'Vendido';
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'BOL48901OS015').errors.join(), /rebajado debe ser menor/);
  assert.match(itemOf(plan, 'RD45747S002').errors.join(), /entero/);
  assert.match(itemOf(plan, 'RD45747M002').errors.join(), /no válido/);
  assert.equal(live(plan).length, 0, 'las filas con error no se suben');
});

test('No se puede cambiar el tipo de una fila existente', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'BOL48901OS015').type = TYPE.variable;
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'BOL48901OS015').errors.join(), /tipo/);
});

test('Alta de producto simple: se crea; sin nombre da error', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.simple, sku: 'NUEVO-1', name: 'Collar nuevo', regularPrice: 250, categories: 'ACCESORIOS > BOLSAS', tags: 'NUEVA ETIQUETA' });
  addRow(excel, { type: TYPE.simple, sku: 'NUEVO-2', regularPrice: 100 });
  const plan = await buildPlan(excel);
  assert.equal(itemOf(plan, 'NUEVO-1').kind, 'create');
  assert.equal(itemOf(plan, 'NUEVO-1').errors.length, 0);
  assert.match(itemOf(plan, 'NUEVO-2').errors.join(), /Nombre/);
  assert.deepEqual(plan.newTerms.tags, ['NUEVA ETIQUETA']);
});

test('ID repetido (fila copiada) bloquea ambas filas', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  const original = rowBySku(excel, 'RD45747S002');
  addRow(excel, { ...original, sku: 'COPIA-1', attr_color: 'Rojo' });
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'RD45747S002').errors.join(), /repetido/);
  assert.match(itemOf(plan, 'COPIA-1').errors.join(), /repetido/);
});

test('SKU repetido en altas', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.simple, sku: 'BOL48901OS015', name: 'Duplicada' });
  const plan = await buildPlan(excel);
  const dup = plan.items.find((i) => i.kind !== 'update' && i.data.name === 'Duplicada');
  assert.ok(dup.errors.length, 'el alta con SKU ya usado no se crea');
});

test('Alta cuyo SKU ya existe en la tienda: se vincula, no se duplica', async () => {
  const catalog = baseCatalog();
  const excel = await excelFrom(catalog);
  const store = [...baseCatalog(), {
    ...baseCatalog()[1], id: 300, sku: 'BOL50462323', name: 'Bolsa Clutch', date_modified: '2026-10-21T10:00:00',
  }];
  mockStore(store);
  addRow(excel, { type: TYPE.simple, sku: 'BOL50462323', name: 'Bolsa Clutch', regularPrice: 499 });
  const plan = await buildPlan(excel);
  const item = itemOf(plan, 'BOL50462323');
  assert.equal(item.kind, 'link');
  assert.equal(item.id, 300);
});

test('Alta cuyo SKU está en la papelera: error claro', async () => {
  const catalog = baseCatalog();
  const excel = await excelFrom(catalog);
  mockStore(catalog, { trash: [{ ...baseCatalog()[1], id: 20318, sku: 'BOL50462323' }] });
  addRow(excel, { type: TYPE.simple, sku: 'BOL50462323', name: 'Bolsa Clutch' });
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'BOL50462323').errors.join(), /PAPELERA/);
});

test('Variación nueva en padre existente con talla nueva: se agrega la opción al padre', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.variation, parentSku: 'RD45747', sku: 'RD45747L002', attr_talla: 'L', attr_color: 'Negro', regularPrice: 699, stock: 4 });
  const plan = await buildPlan(excel);
  assert.equal(itemOf(plan, 'RD45747L002').kind, 'create');
  assert.equal(itemOf(plan, 'RD45747L002').errors.length, 0);
  const parent = itemOf(plan, 'RD45747');
  const talla = parent.attributes.find((a) => a.name === 'Talla');
  assert.deepEqual(talla.options, ['S', 'M', 'L']);
  assert.equal(talla.id, 1, 'conserva el atributo global existente');
});

test('Variación nueva con SKU padre inexistente: error', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.variation, parentSku: 'NOEXISTE', sku: 'X1', attr_talla: 'S', regularPrice: 10 });
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'X1').errors.join(), /NOEXISTE/);
});

test('Perfil con permisos limitados: solo sube los campos permitidos', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  Object.assign(rowBySku(excel, 'BOL48901OS015'), { regularPrice: 549, name: 'Otro nombre' });
  const plan = await buildPlan(excel, { allowedFields: new Set(['regularPrice', 'salePrice', 'stock', 'stockStatus']), canCreate: false });
  const item = itemOf(plan, 'BOL48901OS015');
  assert.deepEqual(item.changes.map((c) => c.key), ['regularPrice']);
  assert.deepEqual(item.skipped.map((c) => c.key), ['name']);
});

test('Perfil sin permiso de alta no puede crear productos', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.simple, sku: 'NUEVO-9', name: 'X', regularPrice: 1 });
  const plan = await buildPlan(excel, { canCreate: false });
  assert.match(itemOf(plan, 'NUEVO-9').errors.join(), /no puede crear/);
});

test('Después del push, el Excel queda al día: un segundo "Revisar" no detecta nada', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'BOL48901OS015').regularPrice = 549;
  addRow(excel, { type: TYPE.simple, sku: 'NUEVO-1', name: 'Collar nuevo', regularPrice: 250 });
  const plan = await buildPlan(excel);

  // Simula que la tienda guardó todo.
  itemOf(plan, 'BOL48901OS015').result = { ok: true, message: 'Actualizado' };
  itemOf(plan, 'NUEVO-1').result = { ok: true, message: 'Creado', newId: 999 };
  syncSheet(excel);
  const after = await readWorkbook(await writeBack(excel, plan, { when: 'hoy' }));

  const store = baseCatalog();
  store[1].regular_price = '549';
  store.push({ ...baseCatalog()[1], id: 999, sku: 'NUEVO-1', name: 'Collar nuevo', regular_price: '250', description: '', categories: [], weight: '', dimensions: { length: '', width: '', height: '' }, stock_quantity: null, manage_stock: false });
  mockStore(store);
  assert.equal(rowBySku(after, 'NUEVO-1').id, 999, 'el producto nuevo recibió su ID');
  const second = await buildPlan(after);
  assert.equal(live(second).length, 0, JSON.stringify(live(second).map((i) => [i.data.sku, i.changes])));
});
