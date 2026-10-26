const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../src/push/plan');
const backup = require('../src/push/backup');
const { undoInStore } = require('../src/push/undo');
const { TYPE, baseCatalog, mockStore, excelFrom, rowBySku, addRow, clone } = require('./helpers');

// Pool falso: guarda los INSERT de push_backups como filas de la base.
function fakePool() {
  const rows = [];
  return {
    rows,
    query: async (sql, p) => {
      if (!sql.includes('INSERT INTO push_backups')) return { rows: [] };
      const isCreate = sql.includes("'create'");
      rows.push(isCreate
        ? { kind: p[1], action: 'create', woo_id: String(p[2]), parent_id: p[3] && String(p[3]), sku: p[4], fields: [], before: null, after: JSON.parse(p[5]) }
        : { kind: p[1], action: 'update', woo_id: String(p[2]), parent_id: p[3] && String(p[3]), sku: p[4], fields: JSON.parse(p[5]), before: JSON.parse(p[6]), after: JSON.parse(p[7]) });
      return { rows: [] };
    },
  };
}

// Simula que la tienda guardó lo que dice el plan (sin la lógica de apply).
function simulatePush(live, plan) {
  const bolsa = live.find((p) => p.id === 200);
  const item = plan.items.find((i) => i.data.sku === 'BOL48901OS015');
  bolsa.regular_price = '549';
  bolsa.description = 'Nueva descripción';
  bolsa.date_modified = '2026-10-23T12:00:00';
  item.result = { ok: true, message: 'Actualizado', data: clone(bolsa) };

  const variation = live[0].variations_data.find((v) => v.id === 101);
  variation.stock_quantity = 50;
  plan.items.find((i) => i.data.sku === 'RD45747S002').result = { ok: true, message: 'Actualizada', data: clone(variation) };

  const nuevo = { ...clone(live[1]), id: 900, sku: 'NUEVO-1', name: 'Collar', date_modified: '2026-10-23T12:00:00' };
  live.push(nuevo);
  plan.items.find((i) => i.data.sku === 'NUEVO-1').result = { ok: true, message: 'Creado', newId: 900, data: clone(nuevo) };
}

async function pushed() {
  const live = mockStore(baseCatalog());
  const excel = await excelFrom(baseCatalog());
  Object.assign(rowBySku(excel, 'BOL48901OS015'), { regularPrice: 549, description: 'Nueva descripción' });
  rowBySku(excel, 'RD45747S002').stock = 50;
  addRow(excel, { type: TYPE.simple, sku: 'NUEVO-1', name: 'Collar', regularPrice: 100 });
  const plan = await buildPlan(excel);
  const snapshot = await backup.snapshotBefore(plan);
  simulatePush(live, plan);
  const pool = fakePool();
  await backup.saveBackup(pool, 1, plan, snapshot);
  return { live, backups: pool.rows };
}

test('El respaldo guarda antes/después solo de los campos que cambian', async () => {
  const { backups } = await pushed();
  const bolsa = backups.find((b) => b.sku === 'BOL48901OS015');
  assert.deepEqual(bolsa.fields.sort(), ['description', 'regular_price']);
  assert.equal(bolsa.before.regular_price, '499');
  assert.equal(bolsa.after.regular_price, '549');
  const variation = backups.find((b) => b.sku === 'RD45747S002');
  assert.equal(variation.kind, 'variation');
  assert.equal(variation.parent_id, '100');
  assert.equal(variation.before.stock_quantity, 5);
  assert.ok(backups.find((b) => b.action === 'create' && b.woo_id === '900'));
});

test('Deshacer regresa todo a como estaba y borra lo creado', async () => {
  const { live, backups } = await pushed();
  const { results } = await undoInStore(backups);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  const bolsa = live.find((p) => p.id === 200);
  assert.equal(bolsa.regular_price, '499');
  assert.equal(bolsa.description, 'Bolsa tejida');
  assert.equal(live[0].variations_data.find((v) => v.id === 101).stock_quantity, 5);
  assert.equal(live.find((p) => p.id === 900), undefined, 'el producto creado se borró');
});

test('Deshacer NO pisa un campo que alguien volvió a cambiar después del push', async () => {
  const { live, backups } = await pushed();
  live.find((p) => p.id === 200).regular_price = '600'; // alguien lo cambió después en WordPress
  const { results } = await undoInStore(backups);
  const bolsa = live.find((p) => p.id === 200);
  assert.equal(bolsa.regular_price, '600', 'se respeta el cambio posterior');
  assert.equal(bolsa.description, 'Bolsa tejida', 'los demás campos sí se restauran');
  assert.match(results.find((r) => r.sku === 'BOL48901OS015').message, /volvió a cambiar/);
});

test('Deshacer NO borra un producto creado si alguien lo editó después', async () => {
  const { live, backups } = await pushed();
  live.find((p) => p.id === 900).date_modified = '2026-10-23T15:00:00';
  const { results } = await undoInStore(backups);
  assert.ok(live.find((p) => p.id === 900), 'no se borró');
  assert.match(results.find((r) => r.sku === 'NUEVO-1').message, /modificó después/);
});

test('Sin respaldo posible no se sube nada', async () => {
  mockStore(baseCatalog());
  const excel = await excelFrom(baseCatalog());
  rowBySku(excel, 'BOL48901OS015').regularPrice = 549;
  const plan = await buildPlan(excel);
  require('../src/woo/store').fetchProductsByIds = async () => { throw new Error('tienda caída'); };
  await assert.rejects(() => backup.snapshotBefore(plan), /tienda caída/);
});
