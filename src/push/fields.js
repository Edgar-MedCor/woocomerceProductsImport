// Reglas por campo: cómo se compara un valor del Excel con la base/tienda, a
// qué tipo de fila aplica y cómo se valida.
const {
  COLUMNS, ATTRIBUTE_COLUMNS, META_COLUMNS, TYPE, STOCK_STATUS, PRODUCT_STATUS, VARIATION_STATUS, DELETE_STATUS, YES_NO, LIST_SEP,
} = require('../excel/layout');

const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const NUMBER_FIELDS = new Set(['regularPrice', 'salePrice', 'stock', 'weight', 'length', 'width', 'height']);
const COMMA_LISTS = new Set(['tags', 'images', 'brand']);
const ATTR_KEYS = new Set(ATTRIBUTE_COLUMNS.map((a) => a.key));
const META_KEYS = new Set(META_COLUMNS.map((m) => m.key));
const ANY = 'cualquiera';

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const isDelete = (status) => String(status ?? '').trim().toLowerCase() === DELETE_STATUS.toLowerCase();

function parseNumber(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[$\s,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const splitList = (v, sep) => (isBlank(v) ? [] : String(v).split(sep).map((s) => s.trim()).filter(Boolean));
const splitCategories = (v) => splitList(v, ',').map((path) => path.split('>').map((s) => s.trim()).filter(Boolean).join(' > '));

// Forma canónica para comparar (dos valores "iguales" para el equipo dan lo mismo).
function canonical(key, value) {
  if (isBlank(value)) return '';
  if (NUMBER_FIELDS.has(key)) {
    const n = parseNumber(value);
    return Number.isNaN(n) ? `invalid:${value}` : String(n);
  }
  if (key === 'categories') return splitCategories(value).join(', ');
  if (COMMA_LISTS.has(key)) return splitList(value, ',').join(', ');
  if (ATTR_KEYS.has(key)) return splitList(value, '|').join(LIST_SEP);
  return String(value).replace(/\r\n/g, '\n').trim();
}

const same = (key, a, b) => canonical(key, a) === canonical(key, b);

// ¿El campo aplica a este tipo de fila? (mismo criterio que las celdas grises del Excel)
function applies(key, type) {
  const level = COL[key]?.level;
  if (level === 'product') return type !== TYPE.variation;
  if (level === 'variation') return type === TYPE.variation;
  if (level === 'priced') return type !== TYPE.variable;
  return true;
}

// Campos que el equipo puede cambiar en filas existentes (tipo y SKU padre solo en altas).
const EDITABLE_ON_UPDATE = COLUMNS.filter((c) => c.editable && !['type', 'parentSku'].includes(c.key)).map((c) => c.key);

const reverse = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [v.toLowerCase(), k]));
const STOCK_STATUS_SLUG = reverse(STOCK_STATUS);
const PRODUCT_STATUS_SLUG = reverse(PRODUCT_STATUS);
const VARIATION_STATUS_SLUG = reverse(VARIATION_STATUS);
const TYPE_BY_LABEL = Object.fromEntries(Object.values(TYPE).map((t) => [t.toLowerCase(), t]));

function normalizeType(value) {
  return TYPE_BY_LABEL[String(value || '').trim().toLowerCase()] || null;
}

// Errores de formato de una fila (lo que no depende de otras filas ni de la tienda).
function validateRow(row, type) {
  const errors = [];
  for (const key of NUMBER_FIELDS) {
    if (applies(key, type) && Number.isNaN(parseNumber(row[key]))) errors.push(`"${COL[key].header}" no es un número: ${row[key]}`);
  }
  const regular = parseNumber(row.regularPrice);
  const sale = parseNumber(row.salePrice);
  if (applies('salePrice', type) && sale !== null && !Number.isNaN(sale)) {
    if (regular === null) errors.push('Tiene precio rebajado pero no precio normal');
    else if (sale >= regular) errors.push('El precio rebajado debe ser menor que el precio normal');
  }
  for (const key of ['regularPrice', 'salePrice', 'stock', 'weight']) {
    if (parseNumber(row[key]) < 0) errors.push(`"${COL[key].header}" no puede ser negativo`);
  }
  const stock = parseNumber(row.stock);
  if (stock !== null && !Number.isNaN(stock) && !Number.isInteger(stock)) errors.push('El inventario debe ser un número entero');

  const statuses = type === TYPE.variation ? VARIATION_STATUS_SLUG : PRODUCT_STATUS_SLUG;
  if (!isBlank(row.status) && !isDelete(row.status) && !statuses[String(row.status).trim().toLowerCase()]) {
    errors.push(`Estado "${row.status}" no válido. Usa: ${Object.values(type === TYPE.variation ? VARIATION_STATUS : PRODUCT_STATUS).join(', ')}`);
  }
  if (!isBlank(row.stockStatus) && !STOCK_STATUS_SLUG[String(row.stockStatus).trim().toLowerCase()]) {
    errors.push(`Disponibilidad "${row.stockStatus}" no válida. Usa: ${Object.values(STOCK_STATUS).join(', ')}`);
  }
  if (!isBlank(row.featured) && !Object.values(YES_NO).map((v) => v.toLowerCase()).includes(String(row.featured).trim().toLowerCase())) {
    errors.push('Destacado debe ser Sí o No');
  }
  return errors;
}

module.exports = {
  COL, ATTRIBUTE_COLUMNS, META_COLUMNS, ATTR_KEYS, META_KEYS, TYPE, ANY, DELETE_STATUS,
  STOCK_STATUS_SLUG, PRODUCT_STATUS_SLUG, VARIATION_STATUS_SLUG, EDITABLE_ON_UPDATE,
  isBlank, isDelete, parseNumber, splitList, splitCategories, canonical, same, applies, normalizeType, validateRow,
};
