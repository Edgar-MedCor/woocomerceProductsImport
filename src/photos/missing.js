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

// Lee las variaciones de estos productos variables (una vez) en `variations_data`.
async function loadVariations(list, progress, label) {
  const pending = list.filter((p) => p.type === 'variable' && p.variations?.length && !p.variations_data);
  let done = 0;
  await withConcurrency(pending, config.photos.concurrency, async (p) => {
    p.variations_data = await store.fetchAllVariations(p.id);
    done += 1;
    progress(done, pending.length, label);
  });
}

/** Productos sin foto (no incluye la papelera); los variables traen sus variaciones en `variations_data`. */
async function findShownWithoutPhotos({ products = null, progress = () => {} } = {}) {
  const all = products || await store.fetchProductsWithStock();
  const bare = all.filter((p) => p.status !== 'trash' && p.type !== 'variation' && !(p.images || []).length);
  await loadVariations(bare, progress, 'Productos sin foto revisados');
  return bare;
}

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const colorOf = (v) => plain((v.attributes || []).find((a) => plain(a.name) === 'color')?.option);
const sortVariations = (variations) => [...variations].sort((a, b) => (a.menu_order ?? 0) - (b.menu_order ?? 0) || a.id - b.id);

/**
 * Fotos que debe tener el producto padre según sus variaciones:
 *  - un solo color (las tallas comparten fotos): la foto principal y toda la
 *    galería, para que se vean sin tener que escoger una talla;
 *  - varios colores: la foto principal de cada color, en el orden de las variaciones.
 */
function parentGalleryFrom(variations) {
  const withImage = sortVariations(variations).filter((v) => v.image?.id);
  if (!withImage.length) return [];
  const singleColor = new Set(withImage.map(colorOf)).size <= 1 || new Set(withImage.map((v) => v.image.id)).size === 1;
  const ids = [];
  for (const v of withImage) {
    for (const id of singleColor ? [v.image.id, ...(v.gallery_image_ids || [])] : [v.image.id]) if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const colorOptions = (p) => ((p.attributes || []).find((a) => plain(a.name) === 'color')?.options || []).length;
const distinctImages = (p) => new Set((p.images || []).map((i) => i.id)).size;

/**
 * Productos variables a los que hay que armarles la galería sin subir nada:
 * los que no tienen foto pero sus variaciones sí, y los de un solo color que
 * solo tienen la foto principal mientras sus variaciones tienen más.
 */
async function findIncompleteParents({ products, progress = () => {} }) {
  const candidates = products.filter((p) => p.type === 'variable' && p.status !== 'trash' && p.variations?.length
    && (!distinctImages(p) || (distinctImages(p) <= 1 && colorOptions(p) <= 1)));
  await loadVariations(candidates, progress, 'Galerías de productos revisadas');
  const out = [];
  for (const p of candidates) {
    const desired = parentGalleryFrom(p.variations_data || []);
    const current = new Set((p.images || []).map((i) => i.id));
    if (!desired.length || desired.every((id) => current.has(id))) continue;
    out.push({
      id: p.id, sku: p.sku, name: p.name,
      reason: current.size
        ? `Solo tiene ${current.size} foto; sus variaciones tienen ${desired.length}. Se le pone la galería completa (no se sube nada nuevo).`
        : 'No tiene foto, pero sus variaciones sí. No se sube nada nuevo.',
      photos: desired.length,
    });
  }
  return out;
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

module.exports = { findShownWithoutPhotos, findIncompleteParents, parentGalleryFrom, photoSources, mediaCode };
