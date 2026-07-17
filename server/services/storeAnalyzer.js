const { findProductBySku, withConcurrency } = require('./wooClient');
const { prepareStore } = require('./storePreparer');

function shouldSkipByMode(exists, mode) {
  if (mode === 'create_only' && exists) return 'Existe en tienda nueva y el modo es solo crear';
  if (mode === 'update_only' && !exists) return 'No existe en tienda nueva y el modo es solo actualizar';
  return '';
}

async function analyzeAgainstStore(api, products, { mode = 'auto' } = {}) {
  const publishable = products.filter((product) => product.sku && product.type !== 'variation');
  const storeCheck = await withConcurrency(publishable, 4, async (product) => {
    const existing = await findProductBySku(api, product.sku);
    const skipReason = shouldSkipByMode(Boolean(existing), mode);
    return {
      sku: product.sku,
      type: product.type,
      exists: Boolean(existing),
      existingId: existing?.id || null,
      action: skipReason ? 'ignore' : existing ? 'update' : 'create',
      reason: skipReason,
    };
  });

  const bySku = new Map(storeCheck.map((item) => [item.sku, item]));
  const productsWithStoreStatus = products.map((product) => {
    if (product.type === 'variation') {
      return {
        ...product,
        storeStatus: {
          action: 'variation_pending_parent',
          exists: null,
          reason: 'Se publicará después de crear o ubicar el producto padre',
        },
      };
    }
    return { ...product, storeStatus: bySku.get(product.sku) || null };
  });

  const catalog = await prepareStore(api, products, { createMissing: false });

  return {
    products: productsWithStoreStatus,
    summary: {
      checkedProducts: storeCheck.length,
      toCreate: storeCheck.filter((item) => item.action === 'create').length,
      toUpdate: storeCheck.filter((item) => item.action === 'update').length,
      toIgnore: storeCheck.filter((item) => item.action === 'ignore').length,
      variations: products.filter((product) => product.type === 'variation').length,
      missingCategories: catalog.missing.categories.length,
      missingTags: catalog.missing.tags.length,
      missingAttributes: catalog.missing.attributes.length,
      missingTerms: catalog.missing.terms.length,
    },
    catalog,
  };
}

module.exports = { analyzeAgainstStore };
