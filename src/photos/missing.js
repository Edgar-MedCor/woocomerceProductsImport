// Productos sin foto: simples y variables sin imagen principal, en cualquier estado
// (los nuevos sin foto quedan "En revisión"). Una variación sin foto de un producto
// que sí tiene foto no cuenta: el producto se ve con foto. Lo usan el reporte de
// productos sin fotos y "Revisar fotos" (búsqueda en Medios), para que coincidan.
const config = require('../config');
const store = require('../woo/store');
const media = require('../woo/media');

// estilo (letras+números) + talla (letras) + color (2 o 3 dígitos)
const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;

async function withConcurrency(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Productos sin foto (no incluye la papelera); los variables traen sus variaciones en `variations_data`. */
async function findShownWithoutPhotos({ progress = () => {} } = {}) {
  const products = await store.fetchProductsWithStock();
  const bare = products.filter((p) => p.status !== 'trash' && p.type !== 'variation' && !(p.images || []).length);
  const variables = bare.filter((p) => p.type === 'variable' && p.variations?.length);
  let done = 0;
  await withConcurrency(variables, config.photos.concurrency, async (p) => {
    p.variations_data = await store.fetchAllVariations(p.id);
    done += 1;
    progress(done, variables.length, 'Productos sin foto revisados');
  });
  return bare;
}

// Código con fotos en Medios: el SKU exacto o, si no, estilo+color (fotos de todas las tallas).
function mediaCode(sku, lookup = media.mediaFor) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) return null;
  const m = code.match(SKU_PARTS);
  return [code, m && m[1] + m[3]].filter(Boolean).find((c) => lookup(c).length) || null;
}

/**
 * Cómo se le pueden poner fotos a un producto sin foto:
 *  - simple: sus fotos en Medios (o ninguna);
 *  - variable: las variaciones sin foto que tienen fotos en Medios; si alguna
 *    variación ya tiene foto, la galería del padre se arma con ellas.
 */
function photoSources(p, lookup = media.mediaFor) {
  if (p.type !== 'variable') {
    const code = mediaCode(p.sku, lookup);
    return { media: code ? [{ id: p.id, sku: p.sku, code, files: lookup(code) }] : [], withPhoto: 0, total: 1 };
  }
  const variations = p.variations_data || [];
  const media = [];
  for (const v of variations.filter((x) => !x.image?.id)) {
    const code = mediaCode(v.sku && v.sku !== p.sku ? v.sku : null, lookup); // sin SKU propio, Woo devuelve el del padre
    if (code) media.push({ id: v.id, sku: v.sku, code, files: lookup(code) });
  }
  return { media, withPhoto: variations.filter((x) => x.image?.id).length, total: variations.length };
}

module.exports = { findShownWithoutPhotos, photoSources, mediaCode };
