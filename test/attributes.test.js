const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../src/push/plan');
const { applyRule } = require('../src/push/attributeRules');
const { TYPE, baseCatalog, mockStore, excelFrom, rowBySku, addRow } = require('./helpers');

const GLOBALS = [
  { id: 1, name: 'Talla', slug: 'pa_talla' },
  { id: 2, name: 'Color', slug: 'pa_color' },
  { id: 3, name: 'Material', slug: 'pa_material' },
  { id: 7, name: 'Tecnica', slug: 'pa_tecnica' },
];
const attr = (id, name, variation, options = ['X']) => ({ id, name, options, visible: true, variation, position: 0 });
const itemOf = (plan, sku) => plan.items.find((i) => String(i.data.sku).toUpperCase() === sku.toUpperCase());

test('Regla: prende Color y Talla, apaga los demás y pasa los locales a global', () => {
  const { attributes, changes, warnings } = applyRule(
    [attr(2, 'Color', false), attr(1, 'Talla', false), attr(0, 'Material', false), attr(0, 'Técnica', true)],
    GLOBALS,
  );
  const by = Object.fromEntries(attributes.map((a) => [a.name, a]));
  assert.equal(by.Color.variation, true);
  assert.equal(by.Talla.variation, true);
  assert.equal(by.Material.id, 3);
  assert.equal(by.Tecnica.id, 7, '"Técnica" local se une al global "Tecnica"');
  assert.equal(by.Tecnica.variation, false);
  assert.equal(changes.length, 5);
  assert.equal(warnings.length, 0);
});

test('Regla: no apaga un atributo que usan las variaciones ni pasa a global un Color local', () => {
  const { attributes, changes, warnings } = applyRule(
    [attr(0, 'Color', true), attr(0, 'Diseño', true), attr(0, 'Marca', false)],
    GLOBALS,
    (a) => a.name === 'Diseño',
  );
  assert.equal(attributes.find((a) => a.name === 'Diseño').variation, true);
  assert.equal(attributes.find((a) => a.name === 'Color').id, 0);
  assert.equal(changes.length, 0);
  assert.equal(warnings.length, 4); // Diseño usado, Color local, Diseño local, Marca sin global
});

test('Push: Talla solo en el padre (S | M) la deja para variaciones', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.variable, sku: 'BOL1', name: 'Bolsa', attr_talla: 'S | M', attr_tecnica: 'Crochet' });
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL1', sku: 'BOL1OS015', attr_color: 'Beige', regularPrice: 10 });
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL1', sku: 'BOL1OS011', attr_color: 'Café', regularPrice: 10 });
  const plan = await buildPlan(excel);
  const by = Object.fromEntries(itemOf(plan, 'BOL1').attributes.map((a) => [a.name, a]));
  assert.equal(by.Color.variation, true);
  assert.equal(by.Talla.variation, true);
  assert.equal(by['Técnica'].variation, false);
});

test('Push: un Variable que se toca por otra razón se corrige si tiene Color apagado', async () => {
  const catalog = baseCatalog();
  const parent = catalog.find((p) => p.type === 'variable');
  parent.attributes.find((a) => a.name === 'Color').variation = false;
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, parent.sku).name = 'Otro nombre';
  const plan = await buildPlan(excel);
  const item = itemOf(plan, parent.sku);
  assert.ok(item.changes.some((c) => c.key === 'attributes'));
  assert.equal(item.attributes.find((a) => a.name === 'Color').variation, true);
});

test('Regla: Talla solo Unitalla no se usa para variaciones si hay Color; sin Color sí', () => {
  const con = applyRule([attr(2, 'Color', true), attr(1, 'Talla', true, ['Unitalla'])], GLOBALS);
  assert.equal(con.attributes.find((a) => a.name === 'Talla').variation, false);
  const sin = applyRule([attr(1, 'Talla', false, ['Unitalla'])], GLOBALS);
  assert.equal(sin.attributes[0].variation, true, 'sin Color, Talla es lo único con qué variar');
});

test('Push: Variable nuevo con Color y Talla Unitalla deja Talla apagada', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.variable, sku: 'BOL2', name: 'Bolsa', attr_talla: 'Unitalla' });
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL2', sku: 'BOL2OS015', attr_color: 'Beige', attr_talla: 'Unitalla', regularPrice: 10 });
  addRow(excel, { type: TYPE.variation, parentSku: 'BOL2', sku: 'BOL2OS011', attr_color: 'Café', attr_talla: 'Unitalla', regularPrice: 10 });
  const plan = await buildPlan(excel);
  const by = Object.fromEntries(itemOf(plan, 'BOL2').attributes.map((a) => [a.name, a]));
  assert.equal(by.Color.variation, true);
  assert.equal(by.Talla.variation, false);
});

test('Variación nueva sin precio: error; con precio: pasa', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  addRow(excel, { type: TYPE.variation, parentSku: 'RD45747', sku: 'RD45747L002', attr_talla: 'L', attr_color: 'Negro', stock: 4 });
  addRow(excel, { type: TYPE.variation, parentSku: 'RD45747', sku: 'RD45747L001', attr_talla: 'L', attr_color: 'Blanco', regularPrice: 699, stock: 4 });
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'RD45747L002').errors.join(), /Precio normal/);
  assert.equal(itemOf(plan, 'RD45747L001').errors.length, 0);
});

test('Borrar el precio de una variación existente: error', async () => {
  const catalog = baseCatalog();
  mockStore(catalog);
  const excel = await excelFrom(catalog);
  rowBySku(excel, 'RD45747S002').regularPrice = null;
  const plan = await buildPlan(excel);
  assert.match(itemOf(plan, 'RD45747S002').errors.join(), /Precio normal/);
});
