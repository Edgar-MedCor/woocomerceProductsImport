// Actualizar precios e inventario de la tienda con los archivos del sistema de la
// empresa (catálogos completos, no solo lo que está en la web):
//   - Precios: una fila por clave ("ClaveCompleta" + "Precio"). Si además trae
//     "PrecioDescuento" (y "PorcentajeDescuento"), también se actualiza el precio
//     rebajado: con descuento se pone, sin descuento se quita.
//   - Inventario: una fila por clave y almacén ("No Almacen", "C Completa",
//     "Categoria", "Existencia"). El inventario de la web es la suma de los
//     almacenes elegidos (por NÚMERO: el nombre puede venir escrito distinto), y si
//     el total queda debajo del mínimo de su categoría se pone 0.
const ExcelJS = require('exceljs');
const { cellValue } = require('../excel/reader');

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const skuKey = (s) => String(s ?? '').trim().toUpperCase();
// Nombre de categoría para comparar: sin acentos, mayúsculas/minúsculas ni espacios de más.
const catKey = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();

// Mínimos por categoría que dio la empresa: debajo de esto se publica 0.
const DEFAULT_THRESHOLDS = {
  ACCESORIOS: 15, ARTESANIA: 5, BISUTERIA: 16, BOLSAS: 10, BOTONES: 50, CABALLERO: 8, 'CHALINAS Y MASCADAS': 16,
  CINTURONES: 16, DAMA: 8, GORRAS: 15, 'INSTRUMENTO MUSICAL': 9, PAREOS: 16, SOMBREROS: 10,
};

const COLUMNS = {
  prices: { sku: ['clavecompleta', 'ccompleta', 'sku'], price: ['precio', 'precionormal'], sale: ['preciodescuento', 'preciorebajado', 'preciocondescuento'], percent: ['porcentajedescuento', 'descuento'] },
  stock: { warehouse: ['noalmacen', 'numalmacen', 'almacen'], warehouseName: ['nomalmacen', 'nombrealmacen'], sku: ['ccompleta', 'clavecompleta', 'sku'], category: ['categoria'], quantity: ['existencia', 'existencias', 'inventario'] },
};
const LABELS = { sku: 'clave completa', price: 'Precio', warehouse: 'No Almacen', warehouseName: 'Nom Almacen', category: 'Categoria', quantity: 'Existencia' };

// Lee la primera hoja: ubica las columnas por su encabezado (sin importar acentos ni espacios).
async function readSheet(buffer, kind) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('El archivo no es un Excel (.xlsx) válido.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas.');
  const wanted = COLUMNS[kind];
  const col = {};
  ws.getRow(1).eachCell((cell, n) => {
    const h = plain(cellValue(cell.value));
    for (const [key, names] of Object.entries(wanted)) if (!col[key] && names.includes(h)) col[key] = n;
  });
  const required = kind === 'prices' ? ['sku', 'price'] : ['warehouse', 'sku', 'category', 'quantity'];
  const missing = required.filter((k) => !col[k]);
  if (missing.length) {
    throw new Error(`No es el archivo de ${kind === 'prices' ? 'precios' : 'inventario'}: le falta la columna ${missing.map((k) => `"${LABELS[k]}"`).join(', ')}.`);
  }
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const out = {};
    for (const [key, c] of Object.entries(col)) out[key] = cellValue(row.getCell(c).value);
    rows.push(out);
  });
  return rows;
}

const toNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Precios: SKU -> precio redondeado a entero (null si viene vacío o en 0).
 * sales (solo si el archivo trae la columna "PrecioDescuento"): SKU -> { price, percent }
 * del precio rebajado, o null si esa clave no tiene descuento (precio con
 * descuento vacío, en 0 o que no queda debajo del precio normal ya redondeado).
 */
async function parsePrices(buffer) {
  const rows = await readSheet(buffer, 'prices');
  const hasSale = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], 'sale');
  const prices = new Map();
  const sales = hasSale ? new Map() : null;
  let withoutPrice = 0;
  for (const r of rows) {
    const sku = skuKey(r.sku);
    if (!sku) continue;
    const n = toNumber(r.price);
    const price = n && n > 0 ? Math.round(n) : null;
    if (price === null) withoutPrice += 1;
    prices.set(sku, price);
    if (sales) {
      const s = toNumber(r.sale);
      const sale = s && s > 0 ? Math.round(s) : null;
      const ok = price !== null && sale !== null && sale < price;
      const pct = toNumber(r.percent);
      sales.set(sku, ok ? { price: sale, percent: pct && pct > 0 ? Math.round(pct * 100) / 100 : Math.round((1 - sale / price) * 10000) / 100 } : null);
    }
  }
  const conDescuento = sales ? [...sales.values()].filter(Boolean).length : 0;
  return { prices, sales, summary: { claves: prices.size, sinPrecio: withoutPrice, ...(sales ? { conDescuento } : {}) } };
}

/** Inventario: filas por almacén, y la lista de almacenes (número, nombre, renglones). */
async function parseStock(buffer) {
  const rows = (await readSheet(buffer, 'stock'))
    .map((r) => ({ warehouse: toNumber(r.warehouse), warehouseName: String(r.warehouseName ?? '').trim(), sku: skuKey(r.sku), category: catKey(r.category), quantity: toNumber(r.quantity) || 0 }))
    .filter((r) => r.sku && r.warehouse !== null);
  const byNumber = new Map();
  for (const r of rows) {
    const w = byNumber.get(r.warehouse) || { number: r.warehouse, name: r.warehouseName, rows: 0 };
    w.rows += 1;
    byNumber.set(r.warehouse, w);
  }
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  return {
    rows,
    warehouses: [...byNumber.values()].sort((a, b) => a.number - b.number),
    categories,
    summary: { claves: new Set(rows.map((r) => r.sku)).size, renglones: rows.length },
  };
}

/**
 * SKU -> { total, category, min, quantity }: suma de los almacenes elegidos (por
 * número); si el total es menor al mínimo de su categoría, quantity = 0.
 */
function stockBySku(rows, warehouses, thresholds = {}) {
  const chosen = new Set(warehouses.map(Number));
  const mins = new Map(Object.entries(thresholds).map(([cat, min]) => [catKey(cat), Number(min)]).filter(([, min]) => Number.isFinite(min) && min > 0));
  const out = new Map();
  for (const r of rows) {
    const entry = out.get(r.sku) || { total: 0, category: r.category };
    if (chosen.has(r.warehouse)) entry.total += r.quantity;
    out.set(r.sku, entry);
  }
  for (const entry of out.values()) {
    entry.total = Math.max(0, Math.round(entry.total));
    entry.min = mins.get(entry.category) ?? null;
    entry.quantity = entry.min && entry.total < entry.min ? 0 : entry.total;
  }
  return out;
}

module.exports = { parsePrices, parseStock, stockBySku, DEFAULT_THRESHOLDS, catKey, skuKey };
