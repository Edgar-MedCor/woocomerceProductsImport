const XLSX = require('xlsx');
const { cleanText, splitList, splitAttributeValues } = require('../../utils/normalizer');

function readRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const firstSheetName = workbook.SheetNames[0];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: '' });
}

function parseSimpleTemplate(filePath) {
  const rows = readRows(filePath);
  const products = rows.map((row, index) => {
    const type = cleanText(row.tipo || row.Tipo || 'simple').toLowerCase();
    const attributes = [
      ['Color', row.color || row.Color],
      ['Talla', row.talla || row.Talla],
      ['Material', row.material || row.Material],
      ['Diseño', row.diseno || row.diseño || row.Diseño],
      ['Sku Generico', row.sku_generico || row['Sku Generico']],
    ]
      .filter(([, value]) => cleanText(value))
      .map(([name, value]) => ({
        name,
        values: splitAttributeValues(value),
        visible: name !== 'Sku Generico',
        global: true,
        variation: ['Talla', 'Color'].includes(name),
      }));

    const product = {
      rowNumber: index + 2,
      source: 'simple_template',
      type,
      sku: cleanText(row.sku || row.SKU),
      genericSku: cleanText(row.sku_generico || row['Sku Generico']),
      name: cleanText(row.nombre || row.Nombre),
      shortDescription: cleanText(row.descripcion_corta || row['Descripción corta']),
      description: cleanText(row.descripcion || row.Descripción),
      regularPrice: cleanText(row.precio || row['Precio normal']),
      salePrice: cleanText(row.precio_rebajado || row['Precio rebajado']),
      stock: cleanText(row.stock || row.Inventario),
      categories: splitList(row.categorias || row.Categorías),
      tags: splitList(row.etiquetas || row.Etiquetas),
      brand: cleanText(row.marca || row.Marcas),
      images: splitList(row.imagenes || row.Imágenes).map((src) => ({ src, source: 'csv' })),
      parentSku: cleanText(row.sku_padre || row.Superior),
      attributes,
      status: 'publish',
      raw: row,
      errors: [],
      warnings: [],
    };

    if (!product.sku) product.errors.push('SKU vacío');
    if (!product.name) product.errors.push('Nombre vacío');
    if (!['simple', 'variable', 'variation'].includes(product.type)) product.errors.push('Tipo inválido');
    if (product.type === 'variation' && !product.parentSku) product.errors.push('Variación sin sku_padre');

    return product;
  });

  return {
    format: 'simple_template',
    totalRows: rows.length,
    columns: rows.length ? Object.keys(rows[0]) : [],
    ignoredColumns: [],
    products,
  };
}

module.exports = { parseSimpleTemplate };
