const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogToRows, COLUMNS, TYPE } = require('../src/excel/layout');
const { canonical, parseNumber, validateRow } = require('../src/push/fields');
const { CATEGORIES, baseCatalog, excelFrom, rowBySku } = require('./helpers');

test('El Excel generado se lee igual a lo que se escribió (ida y vuelta)', async () => {
  const rows = catalogToRows({ products: baseCatalog(), categories: CATEGORIES });
  const excel = await excelFrom(baseCatalog());
  assert.equal(excel.rows.length, rows.length);
  assert.equal(excel.baseRows.length, rows.length, 'la foto oculta tiene las mismas filas');
  for (const original of rows) {
    const read = excel.rows.find((r) => r.id === original.id);
    for (const col of COLUMNS.filter((c) => c.editable)) {
      assert.equal(canonical(col.key, read[col.key]), canonical(col.key, original[col.key]), `${original.sku} · ${col.header}`);
    }
  }
});

test('Padre con variaciones abajo, categorías como ruta completa', async () => {
  const excel = await excelFrom(baseCatalog());
  const parent = rowBySku(excel, 'RD45747');
  assert.equal(parent.type, TYPE.variable);
  assert.equal(parent.categories, 'ROPA DAMA > PANTALON');
  const children = excel.rows.filter((r) => r.parentSku === 'RD45747');
  assert.equal(children.length, 4);
  assert.ok(children.every((c) => c._row > parent._row));
});

test('Números escritos de distintas formas se entienden igual', () => {
  assert.equal(parseNumber('$1,500'), 1500);
  assert.equal(parseNumber(' 799 '), 799);
  assert.equal(canonical('regularPrice', '699.00'), canonical('regularPrice', 699));
  assert.ok(Number.isNaN(parseNumber('mil pesos')));
});

test('Texto inválido en un campo numérico da error en vez de subirse', () => {
  const errors = validateRow({ regularPrice: 'mil pesos' }, TYPE.simple);
  assert.match(errors.join(), /no es un número/);
});

test('Listas: espacios y orden de escritura no generan cambios falsos', () => {
  assert.equal(canonical('tags', 'LINO,  VERANO'), canonical('tags', 'LINO, VERANO'));
  assert.equal(canonical('categories', 'ROPA DAMA>PANTALON'), canonical('categories', 'ROPA DAMA > PANTALON'));
  assert.equal(canonical('attr_talla', 'S|M'), canonical('attr_talla', 'S | M'));
});
