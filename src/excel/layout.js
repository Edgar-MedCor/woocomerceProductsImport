// Definición única de las columnas del Excel. La usan el pull (escribir) y el
// push (leer y comparar). `editable: false` = el push la ignora.
// `level`: a qué fila aplica — 'product' (simple/variable), 'variation', o 'all'.

// Atributos globales que se usan en la tienda, cada uno en su propia columna.
// En la fila del padre van todas las opciones separadas por " | "; en la variante, su valor.
const ATTRIBUTE_COLUMNS = [
  { key: 'attr_color', header: 'Color', names: ['color'] },
  { key: 'attr_talla', header: 'Talla', names: ['talla'] },
  { key: 'attr_material', header: 'Material', names: ['material'] },
  { key: 'attr_tecnica', header: 'Técnica', names: ['tecnica', 'técnica'] },
  { key: 'attr_sku_generico', header: 'Sku genérico', names: ['sku generico', 'sku genérico', 'sku-generico'] },
];

// Medidas de la prenda y línea: no existen como campo en WooCommerce; se guardan
// como meta_data del producto/variante para que el pull las recupere.
const META_COLUMNS = [
  { key: 'meta_linea', header: 'Línea', meta: 'wayan_linea' },
  { key: 'meta_ancho_pecho', header: 'Ancho pecho', meta: 'wayan_ancho_pecho' },
  { key: 'meta_ancho_espalda', header: 'Ancho espalda', meta: 'wayan_ancho_espalda' },
  { key: 'meta_largo', header: 'Largo', meta: 'wayan_largo' },
  { key: 'meta_largo_manga', header: 'Largo manga', meta: 'wayan_largo_manga' },
  { key: 'meta_cintura', header: 'Cintura', meta: 'wayan_cintura' },
  { key: 'meta_tiro_delantero', header: 'Tiro delantero', meta: 'wayan_tiro_delantero' },
  { key: 'meta_tiro_trasero', header: 'Tiro trasero', meta: 'wayan_tiro_trasero' },
  { key: 'meta_escote', header: 'Profundidad escote', meta: 'wayan_profundidad_escote' },
  { key: 'meta_escote_espalda', header: 'Prof. escote espalda', meta: 'wayan_profundidad_escote_espalda' },
];

const COLUMNS = [
  { key: 'id', header: 'ID tienda', width: 9, editable: false, level: 'all' },
  { key: 'type', header: 'Tipo', width: 12, editable: true, level: 'all' },
  { key: 'parentSku', header: 'SKU padre', width: 16, editable: true, level: 'variation' },
  { key: 'sku', header: 'SKU', width: 18, editable: true, level: 'all' },
  { key: 'name', header: 'Nombre', width: 40, editable: true, level: 'product' },
  { key: 'status', header: 'Estado', width: 13, editable: true, level: 'all' },
  { key: 'featured', header: 'Destacado', width: 10, editable: true, level: 'product' },
  { key: 'categories', header: 'Categorías', width: 32, editable: true, level: 'product' },
  { key: 'tags', header: 'Etiquetas', width: 22, editable: true, level: 'product' },
  { key: 'brand', header: 'Marca', width: 12, editable: true, level: 'product' },
  { key: 'shortDescription', header: 'Descripción corta', width: 40, editable: true, level: 'product' },
  { key: 'description', header: 'Descripción', width: 50, editable: true, level: 'all' },
  { key: 'regularPrice', header: 'Precio normal', width: 13, editable: true, level: 'priced', format: '#,##0.00' },
  { key: 'salePrice', header: 'Precio rebajado', width: 13, editable: true, level: 'priced', format: '#,##0.00' },
  { key: 'stock', header: 'Inventario', width: 11, editable: true, level: 'all', format: '0' },
  { key: 'stockStatus', header: 'Disponibilidad', width: 15, editable: true, level: 'all' },
  { key: 'weight', header: 'Peso (kg)', width: 10, editable: true, level: 'all' },
  { key: 'length', header: 'Largo paquete (cm)', width: 11, editable: true, level: 'all' },
  { key: 'width', header: 'Ancho paquete (cm)', width: 11, editable: true, level: 'all' },
  { key: 'height', header: 'Alto paquete (cm)', width: 11, editable: true, level: 'all' },
  ...ATTRIBUTE_COLUMNS.map((a) => ({ ...a, width: 16, editable: true, level: 'all' })),
  { key: 'otherAttributes', header: 'Otros atributos', width: 24, editable: true, level: 'all' },
  { key: 'images', header: 'Imágenes (URLs, la 1ª es la principal)', width: 40, editable: true, level: 'all' },
  ...META_COLUMNS.map((m) => ({ ...m, width: 13, editable: true, level: 'all' })),
  { key: 'modified', header: 'Últ. cambio en tienda', width: 17, editable: false, level: 'all' },
];

const TYPE = { simple: 'Simple', variable: 'Variable', variation: 'Variación' };

const STOCK_STATUS = { instock: 'Disponible', outofstock: 'Agotado', onbackorder: 'Sobre pedido' };
const PRODUCT_STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const VARIATION_STATUS = { publish: 'Activa', private: 'Desactivada' };
const YES_NO = { true: 'Sí', false: 'No' };
const LIST_SEP = ' | ';

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const text = (s) => (s === null || s === undefined ? null : String(s).trim() || null);
const normalize = (s) => String(s || '').trim().toLowerCase();
const date = (d) => (d ? d.replace('T', ' ').slice(0, 16) : null);

// "DAMA > COMPLETOS > VESTIDOS" a partir del árbol de categorías de Woo.
function categoryPaths(product, categoriesById) {
  return (product.categories || []).map((c) => {
    const path = [];
    for (let cat = categoriesById.get(c.id); cat; cat = categoriesById.get(cat.parent)) path.unshift(cat.name);
    return path.join(' > ') || c.name;
  }).join(', ') || null;
}

// Reparte los atributos de Woo entre las columnas fijas y "Otros atributos".
function splitAttributes(attributes, valueOf) {
  const out = {};
  const others = [];
  for (const attr of attributes || []) {
    const col = ATTRIBUTE_COLUMNS.find((a) => a.names.includes(normalize(attr.name)));
    const value = valueOf(attr);
    if (!value) continue;
    if (col) out[col.key] = value;
    else others.push(`${attr.name}: ${value}`);
  }
  out.otherAttributes = others.join('; ') || null;
  return out;
}

function metaValues(item) {
  const byKey = new Map((item.meta_data || []).map((m) => [m.key, m.value]));
  return Object.fromEntries(META_COLUMNS.map((m) => [m.key, text(byKey.get(m.meta))]));
}

const common = (item) => ({
  id: item.id,
  sku: text(item.sku),
  description: text(item.description),
  stock: item.manage_stock === true ? item.stock_quantity : null,
  stockStatus: STOCK_STATUS[item.stock_status] || item.stock_status,
  weight: num(item.weight),
  length: num(item.dimensions?.length),
  width: num(item.dimensions?.width),
  height: num(item.dimensions?.height),
  ...metaValues(item),
  modified: date(item.date_modified),
});

function productRow(p, categoriesById) {
  const isSimple = p.type !== 'variable';
  return {
    ...common(p),
    type: isSimple ? TYPE.simple : TYPE.variable,
    parentSku: null,
    name: p.name,
    status: PRODUCT_STATUS[p.status] || p.status,
    featured: YES_NO[Boolean(p.featured)],
    categories: categoryPaths(p, categoriesById),
    tags: (p.tags || []).map((t) => t.name).join(', ') || null,
    brand: (p.brands || []).map((b) => b.name).join(', ') || null,
    shortDescription: text(p.short_description),
    regularPrice: isSimple ? num(p.regular_price) : null,
    salePrice: isSimple ? num(p.sale_price) : null,
    ...splitAttributes(p.attributes, (a) => (a.options || []).join(LIST_SEP)),
    images: (p.images || []).map((i) => i.src).join(', ') || null,
    _variationCount: p.variations_data?.length ?? null,
  };
}

function variationRow(v, parent) {
  return {
    ...common(v),
    // Un SKU igual al del padre es el heredado por la API (la variación no tiene propio).
    sku: text(v.sku) === text(parent.sku) ? null : text(v.sku),
    type: TYPE.variation,
    parentSku: text(parent.sku),
    name: parent.name, // informativo: la variante toma el nombre del padre
    status: VARIATION_STATUS[v.status] || v.status,
    featured: null,
    categories: null,
    tags: null,
    brand: null,
    shortDescription: null,
    regularPrice: num(v.regular_price),
    salePrice: num(v.sale_price),
    ...splitAttributes(v.attributes, (a) => a.option || 'Cualquiera'),
    images: v.image?.src || null,
    _parentId: parent.id,
  };
}

// Catálogo de Woo -> filas ordenadas: categoría, nombre, y cada padre seguido de sus variantes.
function catalogToRows({ products, categories }) {
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const firstCategory = (p) => categoryPaths({ categories: (p.categories || []).slice(0, 1) }, categoriesById) || '';
  const byCategoryThenName = (a, b) =>
    !firstCategory(a) - !firstCategory(b) // sin categoría al final
    || firstCategory(a).localeCompare(firstCategory(b), 'es', { sensitivity: 'base' })
    || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });

  const rows = [];
  for (const p of [...products].sort(byCategoryThenName)) {
    rows.push(productRow(p, categoriesById));
    if (p.type !== 'variable') continue;
    const variations = [...(p.variations_data || [])].sort((a, b) => a.menu_order - b.menu_order || a.id - b.id);
    for (const v of variations) rows.push(variationRow(v, p));
  }
  return rows;
}

module.exports = {
  COLUMNS, ATTRIBUTE_COLUMNS, META_COLUMNS, TYPE, STOCK_STATUS, PRODUCT_STATUS, VARIATION_STATUS, YES_NO, LIST_SEP,
  catalogToRows,
};
