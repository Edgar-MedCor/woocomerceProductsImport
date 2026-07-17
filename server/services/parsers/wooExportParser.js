const XLSX = require('xlsx');
const {
  cleanText,
  toNumber,
  splitList,
  splitAttributeValues,
} = require('../../utils/normalizer');

const ATTRIBUTE_LIMIT = 5;

function readWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function parseAttributes(row) {
  const attributes = [];

  for (let i = 1; i <= ATTRIBUTE_LIMIT; i++) {
    const name = cleanText(row[`Nombre del atributo ${i}`]);
    const value = cleanText(row[`Valor(es) del atributo ${i}`]);
    if (!name || !value) continue;

    attributes.push({
      name,
      values: splitAttributeValues(value),
      visible: cleanText(row[`Atributo visible ${i}`]) !== '0',
      global: cleanText(row[`Atributo global ${i}`]) !== '0',
      variation: name.toLowerCase() === 'talla' || name.toLowerCase() === 'color',
    });
  }

  return attributes;
}

function extractGenericSku(attributes) {
  const match = attributes.find((attr) => attr.name.toLowerCase().includes('sku generico'));
  return match?.values?.[0] || '';
}

function parseImages(value) {
  return splitList(value).map((url) => ({ src: url, source: 'csv' }));
}

function detectIgnoredColumns(rows, columns) {
  return columns.filter((column) => rows.every((row) => cleanText(row[column]) === ''));
}

function isInventoryOnly(columns) {

  const allowed = [
    "ID",
    "Tipo",
    "SKU",
    "Superior",
    "Inventario"
  ];

  const cols = columns
    .map(c => cleanText(c))
    .filter(Boolean);

  return cols.every(c => allowed.includes(c));

}

function isInventoryOnly(columns = []) {
  const allowed = [
    'ID',
    'Tipo',
    'SKU',
    'Superior',
    'Inventario'
  ];

  return columns.every(col => allowed.includes(col));
}

function normalizeRow(row, index,inventoryOnly = false) {
  const type = cleanText(row.Tipo).toLowerCase();
  const attributes = parseAttributes(row);
  const sku = cleanText(row.SKU);
  const parentSku = cleanText(row.Superior).replace(/^id:/i, '');
  const images = parseImages(row.Imágenes);
  const regularPrice = cleanText(row['Precio normal']);
  const stock = toNumber(row.Inventario, null);

  const product = {
    rowNumber: index + 2,
    source: 'woocommerce_export',
    originalId: cleanText(row.ID),
    type,
    sku,
    genericSku: extractGenericSku(attributes),
    name: cleanText(row.Nombre),
    shortDescription: cleanText(row['Descripción corta']),
    description: cleanText(row.Descripción),
    regularPrice,
    salePrice: cleanText(row['Precio rebajado']),
    stock,
    categories: splitList(row.Categorías),
    tags: splitList(row.Etiquetas),
    brand: cleanText(row.Marcas),
    images,
    parentSku: type === 'variation' ? parentSku : '',
    attributes,
    dimensions: {
      length: cleanText(row['Longitud (cm)']),
      width: cleanText(row['Anchura (cm)']),
      height: cleanText(row['Altura (cm)']),
      weight: cleanText(row['Peso (kg)']),
    },
    status: cleanText(row.Publicado) === '1' ? 'publish' : 'draft',
    raw: row,
    errors: [],
    warnings: [],
  };

 validateProduct(product, inventoryOnly);
  return product;
}

function validateProduct(product, inventoryOnly = false) {

  if (!['simple', 'variable', 'variation'].includes(product.type)) {
    product.errors.push('Tipo inválido');
  }

  if (!product.sku) {
    product.errors.push('SKU vacío');
  }

  if (inventoryOnly) {

    if (product.type === 'variation' && !product.parentSku) {
      product.errors.push('Variación sin producto superior');
    }

    return;
  }

  if (!product.name)
    product.errors.push('Nombre vacío');

  if (product.type === 'simple') {

    if (!product.regularPrice)
      product.warnings.push('Producto simple sin precio normal');

    if (!product.images.length)
      product.warnings.push('Producto simple sin imágenes');

  }

  if (product.type === 'variable') {

    if (!product.attributes.length)
      product.warnings.push('Producto variable sin atributos');

    if (!product.images.length)
      product.warnings.push('Producto variable sin imágenes');

  }

  if (product.type === 'variation') {

    if (!product.parentSku)
      product.errors.push('Variación sin producto superior');

    if (!product.regularPrice)
      product.warnings.push('Variación sin precio normal');

  }

}

function parseWooExport(filePath) {

  const rows = readWorkbook(filePath);

  const columns = rows.length
    ? Object.keys(rows[0])
    : [];

  const ignoredColumns = detectIgnoredColumns(rows, columns);

  const inventoryOnly = isInventoryOnly(columns);

  const products = rows.map(normalizeRow);

  return {

    format: 'woocommerce_export',

    inventoryOnly,

    totalRows: rows.length,

    columns,

    ignoredColumns,

    products,

  };

}

module.exports = { parseWooExport };
