const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parsePrices, parseStock, stockBySku } = require('../src/stockprice/files');
const { stockPriceRows } = require('../src/commands/push');
const { buildPlan } = require('../src/push/plan');
const { cellValue } = require('../src/excel/reader');
const { baseCatalog, mockStore, excelFrom, rowBySku } = require('./helpers');

async function xlsx(header, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const pricesFile = (rows) => xlsx(['FechaCreacion', 'ClaveGenerica', 'ClaveCompleta', 'Descripcion', 'Categoria', 'Precio'], rows);
const stockFile = (rows) => xlsx(['No Almacen', 'Tipo', 'Nom Almacen', 'C Generica', 'C Completa', 'Descripcion', 'Categoria', 'Existencia'], rows);

test('Precios: por ClaveCompleta, redondeado a pesos; vacío o 0 = sin precio', async () => {
  const { prices, summary } = await parsePrices(await pricesFile([
    [1, 'RD45747', 'rd45747s002 ', 'Pantalón', 'DAMA', 648.9968],
    [1, 'X', 'SINPRECIO', 'Algo', 'DAMA', null],
    [1, 'X', 'CERO', 'Algo', 'DAMA', 0],
  ]));
  assert.equal(prices.get('RD45747S002'), 649);
  assert.equal(prices.get('SINPRECIO'), null);
  assert.equal(prices.get('CERO'), null);
  assert.deepEqual(summary, { claves: 3, sinPrecio: 2 });
});

test('Archivo equivocado: dice qué columna falta', async () => {
  await assert.rejects(parsePrices(await stockFile([[1, 'ALMACEN', 'GENERAL', 'A', 'A', 'a', 'DAMA', 1]])), /archivo de precios.*"Precio"/);
  await assert.rejects(parseStock(await pricesFile([[1, 'A', 'A', 'a', 'DAMA', 10]])), /archivo de inventario.*"No Almacen"/);
});

test('Inventario: suma solo los almacenes elegidos (por número) y aplica el mínimo de la categoría', async () => {
  const { rows, warehouses, categories } = await parseStock(await stockFile([
    [1, 'ALMACEN', 'ALMACEN GENERAL', 'A', 'A001', 'a', 'Dama', 6],
    [2, 'TIENDAS', 'americas', 'A', 'A001', 'a', 'DAMA', 3],
    [99, 'TIENDAS', 'OTRA', 'A', 'A001', 'a', 'DAMA', 50],
    [1, 'ALMACEN', 'ALMACÉN general', 'B', 'B001', 'b', 'BISUTERÍA', 10], // nombre distinto, mismo número
    [2, 'TIENDAS', 'AMERICAS', 'C', 'C001', 'c', 'SWIMWEAR', 2],
  ]));
  assert.deepEqual(warehouses.map((w) => [w.number, w.rows]), [[1, 2], [2, 2], [99, 1]]);
  assert.deepEqual(categories, ['BISUTERIA', 'DAMA', 'SWIMWEAR']);
  const t = stockBySku(rows, [1, 2], { DAMA: 8, BISUTERIA: 16 });
  assert.deepEqual([t.get('A001').total, t.get('A001').quantity], [9, 9], 'DAMA: 6 + 3 = 9 ≥ 8 → 9 (el almacén 99 no se suma)');
  assert.deepEqual([t.get('B001').total, t.get('B001').quantity], [10, 0], 'BISUTERÍA: 10 < 16 → 0');
  assert.equal(t.get('C001').quantity, 2, 'categoría sin mínimo: el total');
  assert.equal(stockBySku(rows, [1], { DAMA: 8 }).get('A001').quantity, 0, 'solo el almacén 1: 6 < 8 → 0');
});

test('Revisión: solo precio e inventario de lo que está en la web; avisa lo que no vino; ignora lo que no está en la web', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'RD45747S001').name = 'Cambio a mano que no debe entrar'; // edición pendiente en el Excel
  const { prices } = await parsePrices(await pricesFile([
    [1, 'RD45747', 'RD45747S002', 'p', 'DAMA', 748.9888],
    [1, 'RD45747', 'RD45747M002', 'p', 'DAMA', 699.0016], // igual que hoy
    [1, 'BOL', 'BOL48901OS015', 'b', 'BOLSAS', null], // sin precio
    [1, 'Z', 'NO-ESTA-EN-LA-WEB', 'z', 'DAMA', 100],
  ]));
  const stock = await parseStock(await stockFile([
    [1, 'ALMACEN', 'GENERAL', 'RD45747', 'RD45747S002', 'p', 'DAMA', 20],
    [1, 'ALMACEN', 'GENERAL', 'RD45747', 'RD45747M001', 'p', 'DAMA', 3], // 3 < 8 → 0
    [1, 'ALMACEN', 'GENERAL', 'Z', 'NO-ESTA-EN-LA-WEB', 'z', 'DAMA', 99],
  ]));
  const { rows, report, edits } = stockPriceRows(excel, { prices, stock, warehouses: [1], thresholds: { DAMA: 8 } });
  const plan = await buildPlan({ ...excel, rows }, { canCreate: false, canDelete: false });
  const changed = Object.fromEntries(plan.items.filter((i) => i.changes.length).map((i) => [i.data.sku, i.changes.map((c) => [c.key, c.to])]));
  assert.deepEqual(changed, {
    RD45747S002: [['regularPrice', 749], ['stock', 20]],
    RD45747M001: [['stock', 0], ['stockStatus', 'Agotado']],
  });
  assert.deepEqual(report.sinPrecioEnArchivo.sort(), ['RD45747M001', 'RD45747S001']);
  assert.deepEqual(report.precioVacio, ['BOL48901OS015']);
  assert.deepEqual(report.sinInventarioEnArchivo.sort(), ['BOL48901OS015', 'RD45747M002', 'RD45747S001']);
  assert.equal(report.enCero.length, 1);
  assert.ok(!edits.some((e) => String(e.id) === '100'), 'el producto padre no se toca');
  assert.equal(plan.items.some((i) => i.changes.some((c) => c.key === 'name')), false, 'la edición pendiente del Excel no entra');
});

test('Al subir, la hoja visible del Excel queda con el precio e inventario nuevos', async () => {
  const { applyCellEdits } = require('../src/commands/push');
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  applyCellEdits(excel, [{ id: 101, key: 'regularPrice', value: 749 }, { id: 101, key: 'stock', value: 20 }]);
  const ws = excel.workbook.getWorksheet('Productos');
  const header = {};
  ws.getRow(1).eachCell((c, n) => { header[cellValue(c.value)] = n; });
  const row = ws.getRow(rowBySku(excel, 'RD45747S002')._row);
  assert.equal(cellValue(row.getCell(header['Precio normal']).value), 749);
  assert.equal(cellValue(row.getCell(header.Inventario).value), 20);
});

test('Reporte descargable: cambios, lo que no vino en los archivos y lo que queda en 0 por mínimo', async () => {
  const { buildStockReport } = require('../src/stockprice/report');
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  const { prices } = await parsePrices(await pricesFile([[1, 'RD45747', 'RD45747S002', 'p', 'DAMA', 748.9888]]));
  const stock = await parseStock(await stockFile([[1, 'ALMACEN', 'GENERAL', 'RD45747', 'RD45747M001', 'p', 'DAMA', 3]]));
  const { rows, report } = stockPriceRows(excel, { prices, stock, warehouses: [1], thresholds: { DAMA: 8 } });
  const plan = await buildPlan({ ...excel, rows }, { canCreate: false, canDelete: false });
  const buffer = await buildStockReport(plan, report, { warehouses: [1], warehouseNames: new Map([[1, 'ALMACEN GENERAL']]), thresholds: { DAMA: 8 } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const values = (name) => { const out = []; wb.getWorksheet(name).eachRow((r, i) => { if (i > 1) out.push(r.values.slice(1)); }); return out; };
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Cambios', 'No vinieron en los archivos', 'En 0 por mínimo', 'Parámetros']);
  const cambios = Object.fromEntries(values('Cambios').map((r) => [r[0], r]));
  assert.deepEqual(cambios.RD45747S002.slice(0, 5), ['RD45747S002', 'Pantalon Amplio', 'Variación', 699, 749], 'precio antes → nuevo, con el nombre del producto');
  assert.equal(cambios.RD45747M001[8], 0, 'inventario nuevo 0 por el mínimo');
  assert.ok(values('No vinieron en los archivos').some((r) => r[0] === 'BOL48901OS015' && /precios/.test(r[2])));
  assert.deepEqual(values('En 0 por mínimo').map((r) => [r[0], r[2], r[3], r[4]]), [['RD45747M001', 'DAMA', 3, 8]]);
  assert.match(String(values('Parámetros')[0][1]), /1 ALMACEN GENERAL/);
});

const discountFile = (rows) => xlsx(['FechaCreacion', 'ClaveGenerica', 'ClaveCompleta', 'Descripcion', 'Categoria', 'Precio', 'PorcentajeDescuento', 'PrecioDescuento'], rows);

test('Precios con descuento: lee PrecioDescuento redondeado; sin descuento o no menor al precio = null', async () => {
  const { prices, sales, summary } = await parsePrices(await discountFile([
    [1, 'AN', 'AN18561', 'a', 'DAMA', 1348.9988, 25, 1011.7491],
    [1, 'X', 'SINDESC', 'a', 'DAMA', 798.9964, 0, 798.9964],
    [1, 'X', 'SINPRECIO', 'a', 'DAMA', null, 0, null],
  ]));
  assert.equal(prices.get('AN18561'), 1349);
  assert.deepEqual(sales.get('AN18561'), { price: 1012, percent: 25 });
  assert.equal(sales.get('SINDESC'), null);
  assert.equal(sales.get('SINPRECIO'), null);
  assert.equal(summary.conDescuento, 1);
  const old = await parsePrices(await pricesFile([[1, 'A', 'A1', 'a', 'DAMA', 10]]));
  assert.equal(old.sales, null, 'archivo sin columna de descuento: no se toca el precio rebajado');
});

test('Revisión con descuentos: pone el rebajado a los que tienen descuento, lo quita a los que no, y sale en el reporte', async () => {
  const { buildStockReport } = require('../src/stockprice/report');
  const catalog = baseCatalog();
  catalog[0].variations_data.find((v) => v.sku === 'RD45747S001').sale_price = '500'; // tenía rebaja y ya no
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  const { prices, sales } = await parsePrices(await discountFile([
    [1, 'RD45747', 'RD45747S002', 'p', 'DAMA', 698.9968, 30, 489.2978], // nuevo descuento
    [1, 'RD45747', 'RD45747S001', 'p', 'DAMA', 698.9968, 0, 698.9968], // se quita el rebajado
    [1, 'RD45747', 'RD45747M002', 'p', 'DAMA', 698.9968, 0, 698.9968], // sin cambios
  ]));
  const { rows, report, edits } = stockPriceRows(excel, { prices, sales });
  const plan = await buildPlan({ ...excel, rows }, { canCreate: false, canDelete: false });
  const changed = Object.fromEntries(plan.items.filter((i) => i.changes.length).map((i) => [i.data.sku, i.changes.map((c) => [c.key, c.to])]));
  assert.deepEqual(Object.keys(changed).sort(), ['RD45747S001', 'RD45747S002']);
  assert.deepEqual(changed.RD45747S002.find((c) => c[0] === 'salePrice'), ['salePrice', 489]);
  assert.ok(changed.RD45747S001.some((c) => c[0] === 'salePrice' && (c[1] === null || c[1] === '')));
  assert.ok(plan.items.every((i) => !i.errors.length));
  assert.deepEqual(report.descuentos.map((d) => [d.sku, d.regular, d.sale, d.percent]), [['RD45747S002', 699, 489, 30]]);
  assert.ok(edits.some((e) => e.key === 'salePrice' && e.value === 489));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildStockReport(plan, report));
  assert.ok(wb.getWorksheet('Con descuento'));
  const r = wb.getWorksheet('Con descuento').getRow(2).values.slice(1);
  assert.deepEqual(r.slice(0, 5), ['RD45747S002', 'Pantalon Amplio', 699, 30, 489]);
});
