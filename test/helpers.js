// Catálogo de prueba y tienda simulada en memoria: las pruebas no tocan la
// tienda real ni OneDrive.
const store = require('../src/woo/store');
const { catalogToRows, TYPE } = require('../src/excel/layout');
const { buildWorkbook } = require('../src/excel/writer');
const { readWorkbook } = require('../src/excel/reader');

const clone = (x) => JSON.parse(JSON.stringify(x));

const CATEGORIES = [
  { id: 10, name: 'ROPA DAMA', parent: 0 },
  { id: 11, name: 'PANTALON', parent: 10 },
  { id: 20, name: 'ACCESORIOS', parent: 0 },
  { id: 21, name: 'BOLSAS', parent: 20 },
];
const GLOBAL_ATTRS = [
  { id: 1, name: 'Talla', slug: 'pa_talla' },
  { id: 2, name: 'Color', slug: 'pa_color' },
];

function variation(id, sku, talla, color, price, stock) {
  return {
    id, sku, menu_order: 0, status: 'publish', regular_price: String(price), sale_price: '',
    manage_stock: true, stock_quantity: stock, stock_status: stock > 0 ? 'instock' : 'outofstock',
    attributes: [{ id: 1, name: 'Talla', option: talla }, { id: 2, name: 'Color', option: color }],
    image: null, meta_data: [], weight: '', dimensions: { length: '', width: '', height: '' },
  };
}

// Pantalón con 2 colores x 2 tallas (SKU estilo+talla+color) y una bolsa simple.
function baseCatalog() {
  return [
    {
      id: 100, type: 'variable', name: 'Pantalon Amplio', sku: 'RD45747', status: 'publish', featured: false,
      categories: [{ id: 11 }], tags: [{ name: 'LINO' }], brands: [], short_description: '', description: 'Pantalón fresco',
      regular_price: '', sale_price: '', manage_stock: false, stock_quantity: null, stock_status: 'instock',
      weight: '', dimensions: { length: '', width: '', height: '' }, images: [], meta_data: [], date_modified: '2026-10-01T10:00:00',
      attributes: [
        { id: 1, name: 'Talla', options: ['S', 'M'], variation: true, visible: true, position: 0 },
        { id: 2, name: 'Color', options: ['Negro', 'Blanco'], variation: true, visible: true, position: 1 },
      ],
      variations_data: [
        variation(101, 'RD45747S002', 'S', 'Negro', 699, 5),
        variation(102, 'RD45747M002', 'M', 'Negro', 699, 0),
        variation(103, 'RD45747S001', 'S', 'Blanco', 699, 3),
        variation(104, 'RD45747M001', 'M', 'Blanco', 699, 7),
      ],
    },
    {
      id: 200, type: 'simple', name: 'Bolsa Rafia', sku: 'BOL48901OS015', status: 'publish', featured: false,
      categories: [{ id: 21 }], tags: [], brands: [], short_description: '', description: 'Bolsa tejida',
      regular_price: '499', sale_price: '', manage_stock: true, stock_quantity: 12, stock_status: 'instock',
      weight: '0.4', dimensions: { length: '30', width: '10', height: '25' }, images: [], meta_data: [], attributes: [],
      date_modified: '2026-10-01T10:00:00',
    },
  ];
}

/**
 * Instala una tienda simulada en el módulo store (lo que usa el push).
 * `products`: estado actual de la tienda (puede diferir del Excel para simular conflictos).
 */
function mockStore(products, { trash = [] } = {}) {
  const live = clone(products);
  const strip = (p) => { const { variations_data: _v, ...rest } = p; return clone(rest); };
  store.fetchTaxonomies = async () => ({ categories: clone(CATEGORIES), tags: [{ id: 1, name: 'LINO' }], attributes: clone(GLOBAL_ATTRS), brands: [] });
  store.fetchProductsByIds = async (ids) => live.filter((p) => ids.includes(p.id)).map(strip);
  store.fetchVariationsByIds = async (parentId, ids) => clone((live.find((p) => p.id === parentId)?.variations_data || []).filter((v) => ids.includes(v.id)));
  store.fetchAllVariations = async (parentId) => clone(live.find((p) => p.id === parentId)?.variations_data || []);
  store.fetchProductsBySkus = async (skus) => [...live, ...trash.map((p) => ({ ...p, status: 'trash' }))]
    .filter((p) => skus.map((s) => s.toUpperCase()).includes(String(p.sku).toUpperCase())).map(strip);

  // Escrituras: aplican el payload sobre el estado simulado (para probar "Deshacer").
  const find = (endpoint, id) => {
    const m = endpoint.match(/^products\/(\d+)\/variations/);
    return m ? live.find((p) => p.id === Number(m[1]))?.variations_data.find((v) => v.id === id) : live.find((p) => p.id === id);
  };
  const applyPayload = (obj, payload) => {
    const { id: _id, meta_data: meta, ...rest } = payload;
    Object.assign(obj, clone(rest));
    for (const m of meta || []) {
      obj.meta_data = (obj.meta_data || []).filter((x) => x.key !== m.key).concat([{ key: m.key, value: m.value }]);
    }
    obj.date_modified = new Date().toISOString();
  };
  store.batch = async (endpoint, { update = [] }) => ({
    create: [],
    update: update.map((payload) => {
      const obj = find(endpoint, payload.id);
      if (!obj) return { ok: false, error: 'No existe' };
      applyPayload(obj, payload);
      return { ok: true, data: clone(obj) };
    }),
  });
  store.request = async (method, endpoint) => {
    if (method !== 'delete') throw new Error(`request ${method} no simulado`);
    const v = endpoint.match(/^products\/(\d+)\/variations\/(\d+)$/);
    if (v) {
      const parent = live.find((p) => p.id === Number(v[1]));
      parent.variations_data = parent.variations_data.filter((x) => x.id !== Number(v[2]));
    } else {
      const id = Number(endpoint.split('/')[1]);
      live.splice(live.findIndex((p) => p.id === id), 1);
    }
    return { data: {} };
  };
  return live;
}

// Excel tal como lo generaría un pull de `products`.
async function excelFrom(products) {
  const rows = catalogToRows({ products: clone(products), categories: CATEGORIES });
  const buffer = await buildWorkbook(rows, { source: 'test', lang: 'es', pulledAt: 'test', formatVersion: 2 });
  return readWorkbook(buffer);
}

const rowBySku = (excel, sku) => excel.rows.find((r) => String(r.sku).toUpperCase() === sku.toUpperCase());

// Agrega una fila nueva (alta) al final del Excel.
function addRow(excel, values) {
  const row = { ...values, _row: Math.max(...excel.rows.map((r) => r._row)) + 1 };
  excel.rows.push(row);
  return row;
}

// Escribe en la hoja "Productos" lo que la prueba cambió en excel.rows (como si
// una persona lo hubiera tecleado), para pruebas que vuelven a leer el archivo.
function syncSheet(excel) {
  const { COLUMNS } = require('../src/excel/layout');
  const ws = excel.workbook.getWorksheet('Productos');
  const colByKey = {};
  ws.getRow(1).eachCell((cell, col) => {
    const column = COLUMNS.find((c) => c.header === cell.value);
    if (column) colByKey[column.key] = col;
  });
  for (const row of excel.rows) {
    for (const [k, col] of Object.entries(colByKey)) ws.getRow(row._row).getCell(col).value = row[k] ?? null;
  }
}

module.exports = { TYPE, CATEGORIES, baseCatalog, mockStore, excelFrom, rowBySku, addRow, syncSheet, clone };
