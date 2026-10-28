// Papelera de WordPress para productos y variaciones. Se mandan también sus
// traducciones de WPML: si no, la versión en inglés seguiría en la tienda y
// ocupando el SKU. Antes de tocar nada se anota cómo estaba cada versión
// (estado, slug, SKU y estado de sus variaciones) para poder restaurarla.
const store = require('../woo/store');

// Versiones (idiomas) de un producto o variación: [{ lang, id }]. Sin WPML, solo él mismo.
function versions(obj) {
  const entries = Object.entries(obj?.translations || {});
  return entries.length ? entries.map(([lang, id]) => ({ lang, id: Number(id) })) : [{ lang: null, id: obj.id }];
}

// 410 = ya estaba en la papelera.
const ignoreTrashed = (error) => {
  if (error.response?.status !== 410) throw error;
};

/** Cómo está hoy un producto y sus traducciones (la versión principal va primero). */
async function snapshotProduct(product) {
  const found = await store.fetchProductsAllLanguages(versions(product).map((v) => v.id));
  const out = [];
  for (const p of found) {
    const variations = p.type === 'variable'
      ? (await store.fetchAllVariations(p.id, { allLanguages: true })).map((v) => ({ id: v.id, status: v.status }))
      : [];
    out.push({ id: p.id, lang: p.lang || null, status: p.status, slug: p.slug, sku: p.sku || '', variations });
  }
  if (!out.some((v) => v.id === product.id)) throw new Error(`No se encontró el producto ${product.id} en la tienda.`);
  return out.sort((a, b) => (b.id === product.id) - (a.id === product.id));
}

/** Igual para una variación: cada traducción cuelga de la traducción de su padre. */
function snapshotVariation(variation, parent) {
  if (!variation || !parent) throw new Error('No se encontró la variación en la tienda.');
  const parentByLang = new Map(versions(parent).map((v) => [v.lang, v.id]));
  return versions(variation).map((v) => ({ id: v.id, parentId: parentByLang.get(v.lang) ?? parent.id, status: variation.status }));
}

/**
 * Manda a la papelera todas las versiones. `clearSku` deja libre el SKU (para
 * que lo use la variación que reemplaza a un simple). Si algo falla, regresa
 * lo que alcanzó a mover y lanza el error: o se eliminan todas o ninguna.
 */
async function trashProduct(snapshot, { clearSku = false } = {}) {
  try {
    for (const v of snapshot) {
      if (clearSku && v.sku) await store.request('put', `products/${v.id}`, { sku: '' }, undefined, 1);
      await store.request('delete', `products/${v.id}`, {}, undefined, 1).catch(ignoreTrashed);
    }
  } catch (error) {
    await restoreProduct(snapshot).catch(() => {});
    throw error;
  }
}

async function restoreProduct(snapshot) {
  for (const v of snapshot) {
    await store.request('put', `products/${v.id}`, { status: v.status, slug: v.slug, sku: v.sku }, undefined, 1);
    if (v.variations.length) {
      const res = await store.batch(`products/${v.id}/variations`, { update: v.variations.map(({ id, status }) => ({ id, status })) });
      const failed = res.update.filter((r) => !r.ok);
      if (failed.length) throw new Error(`No se restauraron ${failed.length} variación(es): ${failed[0].error}`);
    }
  }
}

async function trashVariation(snapshot) {
  try {
    for (const v of snapshot) {
      await store.request('delete', `products/${v.parentId}/variations/${v.id}`, {}, undefined, 1).catch(ignoreTrashed);
    }
  } catch (error) {
    await restoreVariation(snapshot).catch(() => {});
    throw error;
  }
}

async function restoreVariation(snapshot) {
  for (const v of snapshot) {
    await store.request('put', `products/${v.parentId}/variations/${v.id}`, { status: v.status }, undefined, 1);
  }
}

module.exports = { snapshotProduct, snapshotVariation, trashProduct, restoreProduct, trashVariation, restoreVariation };
