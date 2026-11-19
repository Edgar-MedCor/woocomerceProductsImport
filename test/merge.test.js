const test = require('node:test');
const assert = require('node:assert/strict');
process.env.WOO_URL ||= 'https://tienda.test';
const store = require('../src/woo/store');
const merge = require('../src/commands/merge');
const { undoInStore } = require('../src/push/undo');
const { mockStore, clone } = require('./helpers');

const base = (o) => ({
  status: 'publish', featured: false, categories: [{ id: 11 }], tags: [], brands: [], short_description: '', description: 'Desc',
  regular_price: '', sale_price: '', manage_stock: false, stock_quantity: null, stock_status: 'instock', weight: '',
  dimensions: { length: '', width: '', height: '' }, images: [], meta_data: [], date_modified: '2026-10-01T10:00:00', ...o,
  permalink: `https://tienda.test/producto/${o.slug}/`,
});
const v = (id, sku, attributes, o = {}) => ({
  id, sku, status: 'publish', regular_price: '699', sale_price: '', manage_stock: true, stock_quantity: 3, stock_status: 'instock',
  attributes, image: null, meta_data: [], weight: '', dimensions: { length: '', width: '', height: '' }, date_modified: '2026-10-01T10:00:00', ...o,
});
const color = (options, variation = true) => ({ id: 2, name: 'Color', options, variation, visible: false, position: 0 });
const talla = (options, variation = false) => ({ id: 1, name: 'Talla', options, variation, visible: false, position: 1 });

function catalog() {
  return [
    // Dos colores armados como Variables + un simple del mismo estilo, sin padre.
    base({ id: 300, type: 'variable', sku: 'RD49321004', name: 'Vestido Umbrella Turquesa Liso', slug: 'vestido-umbrella-turquesa-liso',
      images: [{ id: 90 }, { id: 91 }], attributes: [color(['Turquesa']), talla(['Unitalla']), { id: 5, name: 'Sku Generico', options: ['RD49321'], variation: false, visible: false, position: 2 }],
      variations_data: [v(301, 'RD49321OS004', [{ id: 2, name: 'Color', option: 'Turquesa' }], { image: { id: 91 } }),
        // Resto vacío ("inherit", sin precio, con el SKU del producto): no se pasa.
        v(302, 'RD49321004', [], { status: 'inherit', regular_price: '' })] }),
    base({ id: 310, type: 'variable', sku: 'RD49321021', name: 'Vestido Umbrella Fiusha Liso', slug: 'vestido-umbrella-fiusha-liso', status: 'publish',
      images: [{ id: 95 }], categories: [{ id: 12 }], attributes: [color(['Fiusha']), talla(['Unitalla'])],
      variations_data: [v(311, 'RD49321OS021', [{ id: 2, name: 'Color', option: 'Fiusha' }], { sale_price: '599', gallery_image_ids: [96, 95] })] }),
    base({ id: 320, type: 'simple', sku: 'RD49321OS022', name: 'VESTIDO UMBRELLA VERDE LISO', slug: 'vestido-umbrella-verde', regular_price: '699',
      manage_stock: true, stock_quantity: 2, images: [{ id: 97 }], attributes: [color(['Verde'], false), talla(['Unitalla'])] }),
    // Un solo color: solo cambia el SKU.
    base({ id: 400, type: 'variable', sku: 'RC49198001', name: 'Playera Máscara Blanca', slug: 'playera-mascara-blanca',
      attributes: [color(['Blanco']), talla(['CH', 'M'], true)],
      variations_data: [v(401, 'RC49198S001', [{ id: 2, name: 'Color', option: 'Blanco' }, { id: 1, name: 'Talla', option: 'CH' }])] }),
    // Padre existente (es el color 022, sin color en sus variaciones) + un color suelto con variaciones sin atributos.
    base({ id: 500, type: 'variable', sku: 'RD47342', name: 'Pantalon Recto Con Cintura Bordada', slug: 'pantalon-recto',
      attributes: [color(['Verde Oscuro']), talla(['CH/M', 'G/EG'], true)],
      variations_data: [v(501, 'RD47342SM022', [{ id: 1, name: 'Talla', option: 'CH/M' }]), v(502, 'RD47342LXL022', [{ id: 1, name: 'Talla', option: 'G/EG' }])] }),
    base({ id: 510, type: 'variable', sku: 'RD47342001', name: 'Pantalón Recto Pretina Bordada blanco', slug: 'pantalon-recto-blanco',
      attributes: [color(['Blanco']), talla(['CH/M', 'G/EG'], true)],
      variations_data: [v(511, 'RD47342SM001', []), v(512, 'RD47342LXL001', [])] }),
    // El 004 (turquesa) trae copiado el Color "Negro" del 002.
    base({ id: 600, type: 'variable', sku: 'RD49192002', name: 'Poncho Estampado Negro', slug: 'poncho-negro', attributes: [color(['Negro']), talla(['CH/M', 'G/EG'], true)],
      variations_data: [v(601, 'RD49192SM002', [{ id: 2, name: 'Color', option: 'Negro' }, { id: 1, name: 'Talla', option: 'CH/M' }])] }),
    base({ id: 610, type: 'variable', sku: 'RD49192004', name: 'Poncho Estampado Turquesa', slug: 'poncho-turquesa', attributes: [color(['Negro']), talla(['CH/M', 'G/EG'], true)],
      variations_data: [v(611, 'RD49192SM004', [])] }),
  ];
}

// Tienda simulada con WPML: los productos con lang "en" son traducciones (la API normal no las muestra,
// pero sus SKU sí ocupan lugar). Como en Woo, un SKU no se puede repetir (salvo en la papelera).
function install(extra = []) {
  const live = mockStore([...catalog(), ...extra]);
  const notTrashed = (x) => x.status !== 'trash';
  const spanish = (p) => p.lang !== 'en';
  const strip = ({ variations_data: _v, ...p }) => clone(p);
  store.fetchProductsForOrphans = async () => live.filter((p) => notTrashed(p) && spanish(p) && !p.hidden).map(strip);
  store.fetchVariationSkus = async (id) => clone((live.find((p) => p.id === id)?.variations_data || []).filter(notTrashed));
  store.fetchTranslationsBySkus = async (skus) => live.filter((p) => p.lang === 'en' && notTrashed(p) && skus.includes(p.sku)).map(strip);
  store.fetchVariationsInLang = async (id) => clone((live.find((p) => p.id === id)?.variations_data || []).filter(notTrashed));
  const holders = (sku, selfId) => live.flatMap((p) => [p, ...(p.variations_data || []).map((x) => ({ ...x, parentStatus: p.status }))])
    .filter((x) => x.id !== selfId && x.status !== 'trash' && x.sku && x.sku === sku);
  const request = store.request;
  store.request = async (method, endpoint, data = {}, ...rest) => {
    if (method === 'put' && data.sku) {
      const id = Number(endpoint.split('/').pop());
      if (holders(data.sku, id).length) throw Object.assign(new Error('SKU no válido o duplicado.'), { response: { status: 400, data: { message: 'SKU no válido o duplicado.' } } });
    }
    return request(method, endpoint, data, ...rest);
  };
  return live;
}

// Pool falso: guarda los INSERT de push_backups como filas de la base (como las lee "Deshacer").
function fakePool() {
  const rows = [];
  return {
    rows,
    query: async (sql, p) => {
      if (!sql.includes('INSERT INTO push_backups')) return { rows: [] };
      rows.push({ kind: p[1], action: p[2], woo_id: String(p[3]), parent_id: p[4] && String(p[4]), sku: p[5], fields: JSON.parse(p[6]), before: p[7] && JSON.parse(p[7]), after: p[8] && JSON.parse(p[8]) });
      return { rows: [] };
    },
  };
}

const bySku = (live, sku) => live.find((p) => p.sku === sku);
// JSON con las claves ordenadas (el orden de las claves no importa al comparar).
const stable = (x) => JSON.stringify(x, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val));

test('modelName quita el color y arregla mayúsculas', () => {
  assert.equal(merge.modelName(['Vestido Umbrella Turquesa Liso'], ['Turquesa', 'Fiusha']), 'Vestido Umbrella Liso');
  assert.equal(merge.modelName(['VESTIDO LARGO DE TIRANTES ESTAMPADO NEGRO'], ['Negro']), 'Vestido Largo de Tirantes Estampado');
  assert.equal(merge.modelName(['PANTALON NEGRO', 'Pantalón Recto Pretina Bordada blanco'], ['Blanco', 'Negro']), 'Pantalón Recto Pretina Bordada');
  assert.equal(merge.modelName(['Pantalon Recto pretina bordada azul marino'], ['Azul Marino']), 'Pantalon Recto pretina bordada');
});

test('revisión: modelo nuevo, padre existente y solo SKU', async () => {
  install();
  const review = await merge.reviewMerge({ log: () => {} });
  const byStyle = new Map(review.plans.map((p) => [p.style, p]));
  const umbrella = byStyle.get('RD49321');
  assert.equal(umbrella.mode, 'merge');
  assert.deepEqual(umbrella.errors, []);
  assert.equal(umbrella.modelName, 'Vestido Umbrella Liso');
  assert.equal(umbrella.url, 'https://tienda.test/producto/vestido-umbrella-liso/');
  assert.deepEqual(umbrella.attributes[0].options, ['Turquesa', 'Fiusha', 'Verde']);
  assert.equal(umbrella.attributes[1].variation, false, 'Unitalla con Color no es para variaciones');
  assert.equal(umbrella.entries.length, 3);

  const pant = byStyle.get('RD47342');
  assert.equal(pant.mode, 'into-parent');
  assert.deepEqual(pant.errors, []);
  assert.deepEqual(pant.entries.map((e) => e.talla), ['CH/M', 'G/EG'], 'talla aprendida del código del SKU');
  assert.deepEqual(pant.attributes[0].options, ['Verde Oscuro', 'Blanco']);

  assert.equal(byStyle.get('RC49198').mode, 'rename');
  assert.ok(umbrella.warnings.some((w) => w.includes('RD49321004')), 'avisa de la variación vacía que no pasa');

  const poncho = byStyle.get('RD49192');
  assert.deepEqual(poncho.errors, []);
  assert.deepEqual(poncho.entries.map((e) => e.color), ['Negro', 'Turquesa'], 'el 004 toma el nombre que tiene su código en la tienda');
  assert.ok(poncho.warnings.some((w) => w.includes('Negro → Turquesa')));
  assert.equal(review.summary['Productos que van a la papelera'], 6);
});

test('aplicar y deshacer deja la tienda como estaba', async () => {
  const live = install();
  const before = clone(live);
  const review = await merge.reviewMerge({ log: () => {} });
  const pool = fakePool();
  const result = await merge.applyMerge(review, { selected: new Set(['RD49321', 'RD47342', 'RC49198']), names: { RD49321: 'Vestido Umbrella' }, pool, runId: 1, log: () => {} });
  assert.equal(result.summary['Estilos corregidos'], 3, JSON.stringify(review.plans.map((p) => p.result)));

  // Modelo nuevo con sus 3 colores.
  const model = bySku(live, 'RD49321');
  assert.equal(model.type, 'variable');
  assert.equal(model.name, 'Vestido Umbrella');
  assert.deepEqual(model.categories.map((c) => c.id).sort(), [11, 12]);
  const vars = model.variations_data;
  assert.deepEqual(vars.map((x) => x.sku).sort(), ['RD49321OS004', 'RD49321OS021', 'RD49321OS022']);
  assert.deepEqual(vars.find((x) => x.sku === 'RD49321OS021').attributes, [{ id: 2, option: 'Fiusha' }]);
  assert.equal(vars.find((x) => x.sku === 'RD49321OS021').sale_price, '599');
  assert.deepEqual(vars.find((x) => x.sku === 'RD49321OS021').image, { id: 95 }, 'sin foto propia usa la del producto del color');
  assert.equal(vars.find((x) => x.sku === 'RD49321OS022').stock_quantity, 2);
  // Galería por variación: la de la variación vieja (sin repetir la principal); si no tenía, las demás fotos de su producto.
  assert.deepEqual(vars.find((x) => x.sku === 'RD49321OS021').gallery_image_ids, [96]);
  assert.deepEqual(vars.find((x) => x.sku === 'RD49321OS004').gallery_image_ids, [90]);
  for (const id of [300, 310, 320]) assert.equal(live.find((p) => p.id === id).status, 'trash');

  // Padre existente: recibe el color suelto y sus variaciones reciben su color.
  const parent = live.find((p) => p.id === 500);
  assert.deepEqual(parent.attributes.find((a) => a.id === 2).options, ['Verde Oscuro', 'Blanco']);
  assert.deepEqual(parent.variations_data.find((x) => x.id === 501).attributes, [{ id: 2, option: 'Verde Oscuro' }, { id: 1, option: 'CH/M' }]);
  const moved = parent.variations_data.find((x) => x.sku === 'RD47342SM001');
  assert.deepEqual(moved.attributes, [{ id: 2, option: 'Blanco' }, { id: 1, option: 'CH/M' }]);
  assert.equal(live.find((p) => p.id === 510).status, 'trash');

  // Un color: solo el SKU.
  assert.equal(live.find((p) => p.id === 400).sku, 'RC49198');

  // Deshacer.
  const { results } = await undoInStore(pool.rows, { log: () => {} });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(bySku(live, 'RD49321'), undefined, 'el modelo nuevo se borró');
  const strip = (list) => list.filter((p) => p.id < 5000).map((p) => ({
    id: p.id, sku: p.sku, status: p.status, attributes: stable(p.attributes),
    variations: (p.variations_data || []).filter((x) => x.id < 5000).map((x) => `${x.id}:${x.sku}:${x.status}:${stable(x.attributes)}`),
  }));
  assert.deepEqual(strip(live), strip(before));
});

test('un estilo con errores no se toca', async () => {
  const live = install();
  // Sin color en el producto ni en sus variaciones.
  const p = live.find((x) => x.id === 310);
  p.attributes = [talla(['Unitalla'])];
  p.variations_data[0].attributes = [];
  const review = await merge.reviewMerge({ log: () => {} });
  const umbrella = review.plans.find((x) => x.style === 'RD49321');
  assert.ok(umbrella.errors.some((e) => e.includes('color')));
  const pool = fakePool();
  await merge.applyMerge(review, { selected: new Set(['RD49321']), pool, runId: 1, log: () => {} });
  assert.equal(umbrella.result, undefined);
  assert.equal(bySku(live, 'RD49321'), undefined);
  assert.equal(pool.rows.length, 0);
});

// Estilo de 2 colores donde el 001 tiene versión en inglés con los mismos SKU (como RD40070).
const withEnglish = () => [
  base({ id: 700, type: 'variable', sku: 'RD40070001', name: 'Pantalón Bombacho Blanco', slug: 'bombacho-blanco', attributes: [color(['Blanco']), talla(['CH/M'], true)],
    variations_data: [v(701, 'RD40070SM001', [{ id: 1, name: 'Talla', option: 'CH/M' }])] }),
  base({ id: 710, type: 'variable', sku: 'RD40070002', name: 'Pantalón Bombacho Negro', slug: 'bombacho-negro', attributes: [color(['Negro']), talla(['CH/M'], true)],
    variations_data: [v(711, 'RD40070SM002', [{ id: 1, name: 'Talla', option: 'CH/M' }])] }),
  base({ id: 750, lang: 'en', type: 'variable', sku: 'RD40070001', name: 'Baggy Pants White', slug: 'baggy-white', attributes: [color(['White']), talla(['CH/M'], true)],
    variations_data: [v(751, 'RD40070SM001', [{ id: 1, name: 'Talla', option: 'CH/M' }])] }),
];

test('con versión en inglés: libera su SKU y la manda a la papelera', async () => {
  const live = install(withEnglish());
  // WPML deja repetir el SKU entre traducciones; la tienda simulada lo tiene así desde el inicio.
  const review = await merge.reviewMerge({ log: () => {} });
  const plan = review.plans.find((p) => p.style === 'RD40070');
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => w.includes('versión en inglés')));
  const pool = fakePool();
  await merge.applyMerge(review, { selected: new Set(['RD40070']), pool, runId: 1, log: () => {} });
  assert.equal(plan.result.ok, true, plan.result.message);
  const model = bySku(live, 'RD40070');
  assert.deepEqual(model.variations_data.map((x) => x.sku).sort(), ['RD40070SM001', 'RD40070SM002']);
  const en = live.find((p) => p.id === 750);
  assert.equal(en.status, 'trash');
  assert.equal(en.variations_data[0].sku, '', 'la variación en inglés queda sin SKU');
  assert.ok(pool.rows.some((r) => r.action === 'delete' && r.woo_id === '750'), 'la versión en inglés se puede restaurar con Deshacer');

  // Deshacer: el español regresa con su SKU.
  const { results } = await undoInStore(pool.rows, { log: () => {} });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(bySku(live, 'RD40070'), undefined);
  assert.equal(live.find((p) => p.id === 700).variations_data[0].sku, 'RD40070SM001');
  assert.equal(live.find((p) => p.id === 700).variations_data[0].status, 'publish');
  assert.equal(live.find((p) => p.id === 750).status, 'publish');
});

test('si un SKU no se puede pasar, el estilo regresa completo y no queda nada a medias', async () => {
  // Algo que no aparece en el reporte ocupa RD40070SM002 (como un registro viejo de la tabla de búsqueda).
  const ghost = base({ id: 790, hidden: true, type: 'variable', sku: 'ZZ-FANTASMA', name: 'Fantasma', slug: 'fantasma', attributes: [],
    variations_data: [v(791, 'RD40070SM002', [])] });
  const live = install([...withEnglish(), ghost]);
  const before = clone(live);
  // El fantasma tiene el SKU repetido desde antes: la simulación solo valida al cambiar SKU.
  const review = await merge.reviewMerge({ log: () => {} });
  const plan = review.plans.find((p) => p.style === 'RD40070');
  const pool = fakePool();
  await merge.applyMerge(review, { selected: new Set(['RD40070']), pool, runId: 1, log: () => {} });
  assert.equal(plan.result.ok, false);
  assert.match(plan.result.message, /RD40070SM002/);
  assert.match(plan.result.message, /Se regresó todo/);
  assert.equal(bySku(live, 'RD40070'), undefined, 'el modelo se borró');
  assert.equal(pool.rows.length, 0, 'no queda nada que deshacer');
  // Nada se fue a la papelera; el 001 recupera su SKU. El 002 sigue publicado, pero su SKU no se le
  // pudo regresar (lo ocupa el fantasma, igual que en la tienda real) y el resultado lo dice.
  for (const id of [700, 710]) assert.equal(live.find((p) => p.id === id).status, before.find((p) => p.id === id).status);
  assert.deepEqual(live.find((p) => p.id === 700).variations_data.map((x) => `${x.sku}:${x.status}`), ['RD40070SM001:publish']);
  assert.deepEqual(live.find((p) => p.id === 710).variations_data.map((x) => x.status), ['publish']);
  assert.match(plan.result.message, /OJO: RD40070SM002 sigue publicado/);
});
