const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { buildTargets, donePath, findInMedia } = require('../src/commands/photos');
const media = require('../src/woo/media');
const { skuCandidates, scanPhotos } = require('../src/photos/scan');
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

// OneDrive simulado: "F.S. Dama" con una carpeta que no se reconoce y otra con SKU.
function mockFolders() {
  const onedrive = require('../src/storage/onedrive');
  const img = (name) => ({ id: `file-${name}`, name, file: {} });
  const tree = {
    root: [{ id: 'dama', name: 'F.S. Dama', folder: {} }],
    dama: [{ id: 'flores', name: 'vestido flores', folder: {} }, { id: 'rd', name: 'RD45747', folder: {} }],
    flores: [img('1.jpg'), img('2.jpg')],
    rd: [img('a.jpg')],
  };
  onedrive.getItemByPath = async () => ({ id: 'root', name: 'Falta subir' });
  onedrive.ref = (item) => item;
  onedrive.listChildren = async (item) => tree[item.id] || [];
}

async function scanWith(links = {}) {
  mockFolders();
  const { resolve, resolveChild } = await targets();
  return scanPhotos('Falta subir', resolve, resolveChild, { linkOf: (id) => links[id] || null });
}

test('Carpeta sin SKU: aviso con su ID para poder relacionarla; las demás se reconocen solas', async () => {
  const scan = await scanWith();
  assert.deepEqual(scan.folders.map((f) => f.sku), ['RD45747']);
  const aviso = scan.warnings.find((w) => w.unmatched);
  assert.equal(aviso.folderId, 'flores');
  assert.equal(aviso.path, 'F.S. Dama/vestido flores');
});

test('Carpeta relacionada a mano: sube sus fotos a ese SKU y ya no da aviso', async () => {
  const scan = await scanWith({ flores: { sku: 'bol48901os015', by: 'Ana' } });
  const folder = scan.folders.find((f) => f.relativePath === 'F.S. Dama/vestido flores');
  assert.equal(folder.sku, 'BOL48901OS015');
  assert.equal(folder.target.id, 200);
  assert.equal(folder.linked.by, 'Ana');
  assert.equal(folder.files.length, 2);
  assert.equal(scan.warnings.filter((w) => w.unmatched).length, 0);
});

test('Relación con un SKU que ya no existe: aviso para corregirla, no se sube', async () => {
  const scan = await scanWith({ flores: { sku: 'NO-EXISTE' } });
  assert.equal(scan.folders.length, 1);
  assert.match(scan.warnings.find((w) => w.folderId === 'flores').message, /ya no está en el Excel/);
});

test('Relacionar con un SKU que ya tiene su propia carpeta: no se adivina cuál usar', async () => {
  const scan = await scanWith({ flores: { sku: 'RD45747' } });
  assert.equal(scan.folders.length, 0);
  assert.match(scan.warnings.map((w) => w.message).join(), /tiene 2 carpetas/);
});

test('Al mover a subidas se cambia el prefijo F.S. por S. en cada nivel', () => {
  assert.equal(
    donePath('F.S. Ropa Dama/F.S. Bottoms Dama/F.S. Pantalon Dama'),
    `${config.photos.donePath}/S. Ropa Dama/S. Bottoms Dama/S. Pantalon Dama`,
  );
  assert.equal(donePath('.'), config.photos.donePath);
});

// ---------- Fotos que ya están en Medios ----------
const U = 'https://tienda.test/wp-content/uploads/2026/03/';
function mediaLibrary(files) {
  media._mediaIndex.byCode.clear();
  files.forEach(([id, name]) => media._addToIndex({ id, source_url: U + name }));
  return media.mediaFor;
}

test('Medios: lee SKU-número del nombre del archivo (copias y -scaled incluidas)', () => {
  assert.deepEqual(media.parseMediaName(`${U}RC49206004-1.webp`), { code: 'RC49206004', n: 1, ext: 'webp' });
  assert.deepEqual(media.parseMediaName(`${U}RD49339035-2-1.jpg`), { code: 'RD49339035', n: 2, ext: 'jpg' });
  assert.deepEqual(media.parseMediaName(`${U}rd45747002-3-scaled.webp`), { code: 'RD45747002', n: 3, ext: 'webp' });
  assert.equal(media.parseMediaName(`${U}RD42104004.webp`), null); // sin número: no es del formato
  assert.equal(media.parseMediaName(`${U}foto de vestido.jpg`), null);
});

test('Medios: una foto por número, en orden; de las copias gana la .webp más reciente', () => {
  const lookup = mediaLibrary([[10, 'RC49206004-2.jpg'], [11, 'RC49206004-1.jpg'], [12, 'RC49206004-1.webp'], [13, 'RC49206004-1-1.webp'], [14, 'RC49206004-2.webp']]);
  assert.deepEqual(lookup('rc49206004').map((m) => [m.n, m.id]), [[1, 13], [2, 14]]);
  assert.deepEqual(lookup('NO-EXISTE'), []);
});

test('Medios: busca por SKU exacto o por estilo+color; no toca lo que ya tiene foto o carpeta', async () => {
  const excel = await excelFrom(baseCatalog());
  const { resolve } = buildTargets(excel.rows);
  const row = (sku) => excel.rows.find((r) => r.sku === sku);
  row('RD45747M001').images = `${U}ya-tiene.webp`; // ya tiene foto
  const lookup = mediaLibrary([
    [1, 'RD45747002-1.webp'], [2, 'RD45747002-2.webp'], // negro: todas las tallas
    [3, 'BOL48901OS015-1.webp'], // simple por SKU exacto
    [4, 'RD45747M001-1.webp'], // tiene foto: no se toca
    [5, 'RD45747S001-1.webp'], // tiene carpeta en esta revisión: no se toca
    [6, 'RD45747-1.webp'], // el padre arma su galería con las de sus variaciones
  ]);
  const items = findInMedia(excel.rows, resolve, new Set([103]), lookup);
  const by = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.deepEqual(Object.keys(by).sort(), ['BOL48901OS015', 'RD45747M002', 'RD45747S002']);
  assert.deepEqual(by.RD45747S002.files.map((f) => f.mediaId), [1, 2]);
  assert.equal(by.RD45747S002.target.parentId, 100);
  assert.equal(by.RD45747S002.source, 'media');
  assert.deepEqual(by.BOL48901OS015.files.map((f) => f.mediaId), [3]);
  assert.equal(by.BOL48901OS015.errors.length, 0);
});
