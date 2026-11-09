const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { buildTargets, donePath, mediaItems } = require('../src/commands/photos');
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

// Tienda simulada para "lo que se ve sin foto": el pantalón (variable) y la bolsa (simple), publicados.
function shopWithoutPhotos(edit = () => {}) {
  const store = require('../src/woo/store');
  const { mockStore } = require('./helpers');
  const catalog = baseCatalog();
  edit(catalog);
  mockStore(catalog);
  store.fetchProductsWithStock = async () => catalog.map(({ variations_data: v, ...p }) => ({ ...p, variations: (v || []).map((x) => x.id) }));
  return catalog;
}

test('Sin foto = producto sin imagen principal (cualquier estado menos papelera); variaciones de un producto con foto no cuentan', async () => {
  const { findShownWithoutPhotos } = require('../src/photos/missing');
  shopWithoutPhotos((c) => { c[0].images = [{ id: 9, src: `${U}p.webp` }]; });
  assert.deepEqual((await findShownWithoutPhotos()).map((p) => p.sku), ['BOL48901OS015']);
  shopWithoutPhotos((c) => { c[1].status = 'pending'; }); // los nuevos sin foto quedan "En revisión": sí cuentan
  assert.deepEqual((await findShownWithoutPhotos()).map((p) => p.sku).sort(), ['BOL48901OS015', 'RD45747']);
  shopWithoutPhotos((c) => { c[1].status = 'trash'; });
  assert.deepEqual((await findShownWithoutPhotos()).map((p) => p.sku), ['RD45747']);
});

test('Revisar fotos (Medios): simple por SKU; variable por sus variaciones sin foto (estilo+color); respeta carpetas', async () => {
  const { findShownWithoutPhotos } = require('../src/photos/missing');
  shopWithoutPhotos((c) => { c[0].variations_data[2].image = { id: 9, src: `${U}x.webp` }; }); // RD45747S001 ya tiene foto
  const bare = await findShownWithoutPhotos();
  const lookup = mediaLibrary([[1, 'RD45747002-1.webp'], [2, 'RD45747002-2.webp'], [3, 'BOL48901OS015-1.webp'], [4, 'RD45747001-1.webp']]);
  const items = mediaItems(bare, new Set([102]), lookup); // RD45747M002 ya tiene carpeta
  const by = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.deepEqual(Object.keys(by).sort(), ['BOL48901OS015', 'RD45747M001', 'RD45747S002']);
  assert.deepEqual(by.RD45747S002.files.map((f) => f.mediaId), [1, 2]);
  assert.equal(by.RD45747S002.target.parentId, 100);
  assert.equal(by.RD45747S002.type, TYPE.variation);
  assert.equal(by.BOL48901OS015.type, TYPE.simple);
  assert.equal(new Set(items.map((i) => i.productId)).size, 2); // 2 productos sin foto
});

test('Reporte sin fotos: un renglón por producto publicado sin foto, con SKU, nombre, inventario y estado', async () => {
  const ExcelJS = require('exceljs');
  const { buildNoPhotosReport } = require('../src/photos/noPhotosReport');
  shopWithoutPhotos();
  mediaLibrary([[1, 'RD45747001-1.webp']]);
  const realRefresh = media.refreshMediaIndex;
  media.refreshMediaIndex = async () => 0;
  try {
    const { buffer, summary } = await buildNoPhotosReport();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const rows = [];
    wb.getWorksheet('Sin fotos').eachRow((r, i) => { if (i > 1) rows.push(r.values.slice(1, 8)); });
    const bySku = Object.fromEntries(rows.map((r) => [r[0], r]));
    assert.deepEqual(Object.keys(bySku).sort(), ['BOL48901OS015', 'RD45747']);
    assert.deepEqual(bySku.BOL48901OS015.slice(0, 5), ['BOL48901OS015', 'Bolsa Rafia', 12, 'Publicado', 'Simple']);
    assert.equal(bySku.RD45747[2], 15); // suma del inventario de sus variaciones
    assert.equal(bySku.RD45747[4], 'Variable (4 variaciones)');
    assert.match(bySku.RD45747[6], /^Sí: fotos en Medios para 2 de 4/);
    assert.match(bySku.BOL48901OS015[6], /^No/);
    assert.equal(summary['Productos sin foto'], 2);
    assert.equal(summary['Los arregla "Revisar fotos" (Medios o galería del padre)'], 1);
  } finally {
    media.refreshMediaIndex = realRefresh;
  }
});
