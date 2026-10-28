const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../src/push/plan');
const { applyPlan } = require('../src/push/apply');
const { writeBack } = require('../src/push/writeback');
const backup = require('../src/push/backup');
const { undoInStore } = require('../src/push/undo');
const { findOrphans } = require('../src/report/orphans');
const { readWorkbook } = require('../src/excel/reader');
const { TYPE, baseCatalog, mockStore, excelFrom, rowBySku, addRow, syncSheet, clone } = require('./helpers');

const live = (plan) => plan.items.filter((i) => !i.errors.length && i.changes.length);
const itemOf = (plan, sku) => plan.items.find((i) => String(i.data.sku).toUpperCase() === sku.toUpperCase());

// Variante que se dio de alta como producto simple (convención vieja del equipo).
function catalogWithLoose() {
  const catalog = baseCatalog();
  catalog.push({
    id: 300, type: 'simple', name: 'Pantalon Amplio L Negro', sku: 'RD45747L002', status: 'publish', slug: 'pantalon-l-negro',
    permalink: 'https://tienda.test/pantalon-l-negro', featured: false, categories: [{ id: 11 }], tags: [], brands: [],
    short_description: '', description: 'Duplicado', regular_price: '699', sale_price: '', manage_stock: true, stock_quantity: 4,
    stock_status: 'instock', weight: '', dimensions: { length: '', width: '', height: '' }, meta_data: [], attributes: [],
    images: [{ id: 71, src: 'https://tienda.test/a.jpg' }, { id: 72, src: 'https://tienda.test/b.jpg' }],
    date_modified: '2026-10-01T10:00:00',
  });
  return catalog;
}

// Pool falso: guarda los INSERT de push_backups como filas de la base.
function fakePool() {
  const rows = [];
  return {
    rows,
    query: async (sql, p) => {
      if (!sql.includes('INSERT INTO push_backups')) return { rows: [] };
      const base = { kind: p[1], woo_id: String(p[2]), parent_id: p[3] && String(p[3]), sku: p[4] };
      if (sql.includes("'create'")) rows.push({ ...base, action: 'create', fields: [], before: null, after: JSON.parse(p[5]) });
      else if (sql.includes("'delete'")) rows.push({ ...base, action: 'delete', fields: [], before: JSON.parse(p[5]), after: null });
      else rows.push({ ...base, action: 'update', fields: JSON.parse(p[5]), before: JSON.parse(p[6]), after: JSON.parse(p[7]) });
      return { rows: [] };
    },
  };
}

// Push completo contra la tienda simulada: respaldo, aplicar y guardar respaldo.
async function push(plan) {
  const snapshot = await backup.snapshotBefore(plan);
  await applyPlan(plan);
  const pool = fakePool();
  await backup.saveBackup(pool, 1, plan, snapshot);
  return pool.rows;
}

async function convertLoose(options = { canDelete: true }) {
  const catalog = catalogWithLoose();
  const store = mockStore(catalog);
  const excel = await excelFrom(catalog);
  Object.assign(rowBySku(excel, 'RD45747L002'), { type: TYPE.variation, parentSku: 'RD45747', attr_talla: 'L', attr_color: 'Negro' });
  return { store, excel, plan: await buildPlan(excel, options) };
}

test('Simple → Variación: reemplaza al simple y pasa su SKU, precio y estado', async () => {
  const { plan } = await convertLoose();
  const item = itemOf(plan, 'RD45747L002');
  assert.deepEqual(item.errors, []);
  assert.equal(item.kind, 'create');
  assert.equal(item.replaces.id, 300);
  assert.equal(item.data.status, 'Activa', '"Publicado" de producto pasa a "Activa" de variación');
  assert.ok(!item.changes.some((c) => c.key === 'description'), 'la descripción larga no pasa');
  const parent = itemOf(plan, 'RD45747');
  assert.match(parent.changes.find((c) => c.key === 'attributes').to, /Talla: S \| M \| L/);
  assert.equal(plan.summary['Simples que pasan a variación'], 1);
});

test('Simple → Variación sin permiso de eliminar: no se sube', async () => {
  const { plan } = await convertLoose({ canDelete: false });
  assert.match(itemOf(plan, 'RD45747L002').errors.join(), /permiso de eliminar/);
});

test('Variación nueva con el SKU de un simple: explica cómo convertirlo', async () => {
  const catalog = catalogWithLoose();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'RD45747L002').sku = 'RD45747L002-VIEJO'; // para que el SKU no se repita en el Excel
  addRow(excel, { type: TYPE.variation, parentSku: 'RD45747', sku: 'RD45747L002', attr_talla: 'L', attr_color: 'Negro', regularPrice: 699 });
  const plan = await buildPlan(excel, { canDelete: true });
  const nuevo = plan.items.find((i) => i.kind === 'create' && i.data.sku === 'RD45747L002');
  assert.match(nuevo.errors.join(), /ya es del producto simple ID 300/);
});

test('Convertir y deshacer: el simple va a la papelera, la variación reusa sus fotos, y "Deshacer" lo regresa', async () => {
  const { store, plan } = await convertLoose();
  const backups = await push(plan);

  const simple = store.find((p) => p.id === 300);
  assert.equal(simple.status, 'trash');
  assert.equal(simple.sku, '', 'el SKU se libera');
  const variation = store.find((p) => p.id === 100).variations_data.find((v) => v.sku === 'RD45747L002');
  assert.ok(variation, 'se creó la variación');
  assert.deepEqual(variation.image, { id: 71 }, 'reusa la foto principal sin subirla otra vez');
  assert.deepEqual(variation.gallery_image_ids, [72]);
  assert.equal(itemOf(plan, 'RD45747L002').result.ok, true);
  assert.ok(backups.some((b) => b.action === 'delete' && b.woo_id === '300'));

  const { results } = await undoInStore(backups);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(store.find((p) => p.id === 100).variations_data.some((v) => v.sku === 'RD45747L002'), false, 'la variación se borró');
  assert.equal(simple.status, 'publish');
  assert.equal(simple.sku, 'RD45747L002', 'recupera su SKU');
});

test('Después de convertir, el Excel queda al día: la fila es la variación nueva', async () => {
  const { excel, plan } = await convertLoose();
  syncSheet(excel);
  await applyPlan(plan);
  const again = await readWorkbook(await writeBack(excel, plan));
  const row = again.rows.find((r) => r.sku === 'RD45747L002');
  assert.equal(row.status, 'Activa');
  assert.equal(String(row.id), String(itemOf(plan, 'RD45747L002').result.newId));
  assert.match(row.url, /^https:\/\/tienda\.test/, 'la columna "Ver en tienda" trae el enlace');
  const next = await buildPlan(again, { canDelete: true });
  assert.equal(live(next).length, 0);
  assert.deepEqual(next.notes, [], 'no aparece como fila borrada');
});

test('Si la variación no se puede crear, el simple se restaura en el momento', async () => {
  const { store, plan } = await convertLoose();
  store.find((p) => p.id === 100).variations_data[0].sku = 'RD45747L002'; // otro ya ocupa el SKU
  await applyPlan(plan);
  const item = itemOf(plan, 'RD45747L002');
  assert.equal(item.result.ok, false);
  assert.match(item.result.message, /se restauró como estaba/);
  const simple = store.find((p) => p.id === 300);
  assert.equal(simple.status, 'publish');
  assert.equal(simple.sku, 'RD45747L002');
});

test('Eliminar: sin permiso da error; con permiso va a la papelera con sus variaciones', async () => {
  const catalog = baseCatalog();
  const store = mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'RD45747').status = 'Eliminar';
  rowBySku(excel, 'RD45747S002').status = 'Eliminar';
  rowBySku(excel, 'RD45747M002').regularPrice = 799;

  const denied = await buildPlan(excel);
  assert.match(itemOf(denied, 'RD45747').errors.join(), /permiso para eliminar/);

  const plan = await buildPlan(excel, { canDelete: true });
  const parent = itemOf(plan, 'RD45747');
  assert.equal(parent.kind, 'delete');
  assert.deepEqual(parent.errors, []);
  assert.equal(itemOf(plan, 'RD45747S002').changes.length, 0, 'su variación se va con el padre');
  assert.match(itemOf(plan, 'RD45747M002').errors.join(), /padre se va a eliminar/);
  assert.equal(plan.summary['A eliminar (papelera)'], 1);

  const backups = await push(plan);
  assert.equal(store[0].status, 'trash');
  assert.ok(store[0].variations_data.every((v) => v.status === 'trash'));

  const { results } = await undoInStore(backups);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(store[0].status, 'publish');
  assert.ok(store[0].variations_data.every((v) => v.status === 'publish'), 'las variaciones vuelven como estaban');
});

test('Eliminar una variación: va a la papelera y se restaura', async () => {
  const catalog = baseCatalog();
  const store = mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'RD45747M001').status = 'eliminar'; // sin importar mayúsculas
  const plan = await buildPlan(excel, { canDelete: true });
  assert.equal(live(plan).length, 1);
  const backups = await push(plan);
  const variation = store[0].variations_data.find((v) => v.id === 104);
  assert.equal(variation.status, 'trash');
  await undoInStore(backups);
  assert.equal(variation.status, 'publish');
});

test('Después de eliminar, la siguiente revisión no vuelve a detectar la fila', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'BOL48901OS015').status = 'Eliminar';
  syncSheet(excel);
  const plan = await buildPlan(excel, { canDelete: true });
  await applyPlan(plan);
  const again = await readWorkbook(await writeBack(excel, plan));
  const next = await buildPlan(again, { canDelete: true });
  assert.equal(live(next).length, 0);
  assert.equal(next.items.filter((i) => i.errors.length).length, 0);
});

test('Fila nueva marcada "Eliminar": se ignora con aviso', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.simple, sku: 'X-1', name: 'Borrar', status: 'Eliminar' });
  const plan = await buildPlan(excel, { canDelete: true });
  assert.equal(live(plan).length, 0);
  assert.match(plan.notes.join(), /se ignoraron/);
});

test('Simple → Variable con sus variaciones nuevas', async () => {
  const catalog = baseCatalog();
  const store = mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'BOL48901OS015').type = TYPE.variable;
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL48901OS015', sku: 'BOL48901OS016', attr_color: 'Rojo', regularPrice: 499, stock: 3 });
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL48901OS015', sku: 'BOL48901OS017', attr_color: 'Azul', regularPrice: 499, stock: 2 });
  const plan = await buildPlan(excel);
  const bolsa = itemOf(plan, 'BOL48901OS015');
  assert.deepEqual(bolsa.errors, []);
  assert.ok(bolsa.changes.some((c) => c.key === 'type'));
  assert.ok(bolsa.changes.some((c) => c.key === 'attributes'));
  assert.ok(plan.items.filter((i) => i.type === TYPE.variation && i.kind === 'create').every((i) => i.parentId === 200 && !i.errors.length));

  const backups = await push(plan);
  const product = store.find((p) => p.id === 200);
  assert.equal(product.type, 'variable');
  assert.equal(product.variations_data.length, 2);

  await undoInStore(backups);
  assert.equal(product.type, 'simple', 'Deshacer lo regresa a simple');
  assert.equal(product.variations_data.length, 0, 'y borra las variaciones creadas');
});

test('Reporte de variantes sueltas: agrupa simples por estilo', () => {
  const products = [
    { id: 1, type: 'variable', sku: 'RD100', name: 'Vestido', permalink: 'u1' },
    { id: 2, type: 'simple', sku: 'RD100S002', name: 'Vestido S', status: 'publish' },
    { id: 3, type: 'simple', sku: 'RD200S002', name: 'Blusa S', status: 'publish' },
    { id: 4, type: 'simple', sku: 'RD200M002', name: 'Blusa M', status: 'draft' },
    { id: 5, type: 'simple', sku: 'BOL1OS015', name: 'Bolsa talla única', status: 'publish' },
    { id: 6, type: 'simple', sku: 'COLLAR-1', name: 'Collar', status: 'publish' },
  ];
  const groups = findOrphans(clone(products));
  assert.deepEqual(groups.map((g) => g.style), ['RD200', 'RD100'], 'la bolsa sola y el collar no aparecen');
  assert.equal(groups[1].parent.type, 'Variable');
  assert.equal(groups[0].parent, null);
  assert.deepEqual(groups[0].items.map((i) => i.talla), ['M', 'S']);
});
