function countBy(products, field) {
  return products.reduce((acc, item) => {
    const key = item[field] || 'empty';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function getDuplicateSkus(products) {
  const counts = countBy(products.filter((p) => p.sku), 'sku');
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([sku, count]) => ({ sku, count }));
}

function collectCategories(products) {
  return [...new Set(products.flatMap((p) => p.categories || []).filter(Boolean))].sort();
}

function collectAttributes(products) {
  const map = new Map();

  products.forEach((product) => {
    (product.attributes || []).forEach((attr) => {
      if (!map.has(attr.name)) map.set(attr.name, new Set());
      (attr.values || []).forEach((value) => map.get(attr.name).add(value));
    });
  });

  return [...map.entries()].map(([name, values]) => ({
    name,
    values: [...values].sort(),
  }));
}

function validateRelations(products) {
  const parentSkus = new Set(products.filter((p) => p.type === 'variable').map((p) => p.sku));

  products.forEach((product) => {
    if (product.type === 'variation' && product.parentSku && !parentSkus.has(product.parentSku)) {
      product.errors.push(`Producto superior no encontrado: ${product.parentSku}`);
    }
  });
}

function analyzeCatalog(parsed, options = {}) {

  const mode = options.mode || "full";

  const products = parsed.products;

  if (mode !== "inventory") {
    validateRelations(products);
  }

  const productsWithErrors = products.filter((p) => p.errors.length);
  const productsWithWarnings = products.filter((p) => p.warnings.length);
  const duplicateSkus = getDuplicateSkus(products);

  return {
    format: parsed.format,
    totalRows: parsed.totalRows,
    columns: parsed.columns,
    ignoredColumns: parsed.ignoredColumns,
    mode,
    summary: {
      total: products.length,
      byType: countBy(products, 'type'),
      errors: productsWithErrors.length,
      warnings: productsWithWarnings.length,
      duplicateSkus: duplicateSkus.length,
      categories: mode === "inventory" ? 0 : collectCategories(products).length,
      attributes: mode === "inventory" ? 0 : collectAttributes(products).length,
    },
    duplicateSkus,
    categories: mode === "inventory" ? [] : collectCategories(products),
    attributes: mode === "inventory" ? [] : collectAttributes(products),
    products,
  };
}

module.exports = { analyzeCatalog };
