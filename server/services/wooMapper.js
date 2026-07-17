function mapImages(images = []) {
  return images
    .map((image) => {

      // Ya está subida a WordPress
      if (image.id) {
        return { id: image.id };
      }

      // URL remota (CSV)
      if (image.src || image.remoteUrl) {
        return {
          src: image.src || image.remoteUrl
        };
      }

      // Imagen subida desde el dashboard
      if (image.source === "upload") {
        return {
          localPath: image.path,
          filename: image.filename,
          originalName: image.originalName
        };
      }

      return null;
    })
    .filter(Boolean);
}



function mapAttributes(attributes = [], productType = 'simple', context = {}) {
  return attributes
    .filter((attr) => attr.name && attr.values?.length)
    .filter((attr) => !attr.name.toLowerCase().includes('sku generico'))
    .map((attr) => {
      const id = context.attributeMap?.[attr.name];
      const base = {
        visible: attr.visible !== false,
        variation: productType === 'variable' ? Boolean(attr.variation) : false,
        options: attr.values,
      };
      return id ? { id, ...base } : { name: attr.name, ...base };
    });
}

function mapVariationAttributes(attributes = [], context = {}) {
  return attributes.flatMap((attr) =>
    (attr.values || []).slice(0, 1).map((option) => {
      const id = context.attributeMap?.[attr.name];
      return id ? { id, option } : { name: attr.name, option };
    })
  );
}

function mapCategories(categories = [], context = {}) {
  return categories
    .map((name) => {
      const id = context.categoryMap?.[name];
      return id ? { id } : { name };
    })
    .filter((item) => item.id || item.name);
}

function mapTags(tags = [], context = {}) {
  return tags
    .map((name) => {
      const id = context.tagMap?.[name];
      return id ? { id } : { name };
    })
    .filter((item) => item.id || item.name);
}

function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)
  );
}

function productToWooPayload(product, context = {}) {
  return cleanPayload({
    type: product.type === 'variable' ? 'variable' : 'simple',
    sku: product.sku,
    name: product.name,
    status: context.defaultStatus || product.status || 'publish',
    description: product.description || '',
    short_description: product.shortDescription || '',
    regular_price: product.type === 'simple' ? String(product.regularPrice || '') : undefined,
    sale_price: product.salePrice ? String(product.salePrice) : undefined,
    manage_stock: product.stock !== null && product.stock !== undefined && product.stock !== '',
    stock_quantity: product.stock !== null && product.stock !== undefined && product.stock !== '' ? Number(product.stock) : undefined,
    categories: mapCategories(product.categories, context),
    tags: mapTags(product.tags || [], context),
    images: mapImages(product.images),
    attributes: mapAttributes(product.attributes, product.type, context),
    dimensions: product.dimensions,
  });
}

function variationToWooPayload(variation, context = {}) {
  return cleanPayload({
    sku: variation.sku,
    regular_price: String(variation.regularPrice || ''),
    sale_price: variation.salePrice ? String(variation.salePrice) : undefined,
    manage_stock: variation.stock !== null && variation.stock !== undefined && variation.stock !== '',
    stock_quantity: variation.stock !== null && variation.stock !== undefined && variation.stock !== '' ? Number(variation.stock) : undefined,
    attributes: mapVariationAttributes(variation.attributes || [], context),
  });
}

module.exports = { productToWooPayload, variationToWooPayload, mapImages };
