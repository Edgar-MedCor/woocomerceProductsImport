const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { buildTargets, donePath } = require('../src/commands/photos');
const { skuCandidates } = require('../src/photos/scan');
const { TYPE, baseCatalog, excelFrom, addRow } = require('./helpers');

async function targets(extraRows = []) {
  const excel = await excelFrom(baseCatalog());
  extraRows.forEach((r) => addRow(excel, r));
  return buildTargets(excel.rows);
}

test('Carpeta con el SKU exacto del padre: galería del producto', async () => {
  const { resolve } = await targets();
  const t = resolve('RD45747');
  assert.equal(t.kind, 'product');
  assert.equal(t.type, TYPE.variable);
  assert.equal(t.id, 100);
});

test('Carpeta estilo+color (sin talla): foto de todas las tallas de ese color', async () => {
  const { resolve } = await targets();
  const t = resolve('RD45747002');
  assert.equal(t.kind, 'color');
  assert.equal(t.parentId, 100);
  assert.deepEqual(t.variations.map((v) => v.id).sort(), [101, 102]);
});

test('Carpeta estilo+color de un producto simple: su galería', async () => {
  const { resolve } = await targets();
  const t = resolve('BOL48901015');
  assert.equal(t.kind, 'product');
  assert.equal(t.id, 200);
});

test('Carpeta con SKU exacto de variación', async () => {
  const { resolve } = await targets();
  const t = resolve('RD45747M001');
  assert.equal(t.kind, 'product');
  assert.equal(t.type, TYPE.variation);
  assert.equal(t.parentId, 100);
});

test('Color de 2 dígitos (SKU de prueba BOL50462323S12)', async () => {
  const { resolve } = await targets([
    { type: TYPE.variable, sku: 'BOL50462323', name: 'Bolsa Clutch', id: 300 },
    { type: TYPE.variation, parentSku: 'BOL50462323', sku: 'BOL50462323S12', attr_color: 'Beige', id: 301 },
  ]);
  const t = resolve('BOL5046232312');
  assert.equal(t.kind, 'color');
  assert.deepEqual(t.variations.map((v) => v.id), [301]);
});

test('Carpeta que no coincide con nada: no se adivina', async () => {
  const { resolve } = await targets();
  assert.equal(resolve('RD4574700'), null);
  assert.equal(resolve('RD99999002'), null);
});

test('Un código estilo+color que cae en dos productos distintos no se asigna', async () => {
  const { resolve } = await targets([
    { type: TYPE.variable, sku: 'OTRO', name: 'Otro', id: 400 },
    { type: TYPE.variation, parentSku: 'OTRO', sku: 'RD45747L002', attr_color: 'Negro', id: 401 },
  ]);
  assert.equal(resolve('RD45747002'), null);
});

test('Nombres de carpeta con texto extra', () => {
  assert.ok(skuCandidates('RD48415015 - vestido flores').includes('RD48415015'));
  assert.ok(skuCandidates('rd48415015_fotos').includes('RD48415015'));
  assert.ok(skuCandidates('RD45747002 -1').includes('RD45747002'));
});

test('Al mover a subidas se cambia el prefijo F.S. por S. en cada nivel', () => {
  assert.equal(
    donePath('F.S. Ropa Dama/F.S. Bottoms Dama/F.S. Pantalon Dama'),
    `${config.photos.donePath}/S. Ropa Dama/S. Bottoms Dama/S. Pantalon Dama`,
  );
  assert.equal(donePath('.'), config.photos.donePath);
});
