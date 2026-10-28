// Reporte de "variantes sueltas": productos simples cuyo SKU tiene la forma de
// una variación (estilo + talla + color, ej. RD49432 + OM + 005). Antes se
// daban de alta así, y casi siempre debían ser variaciones de un producto
// Variable con el SKU del estilo. Solo lee; no modifica nada.
const store = require('../woo/store');

// Misma convención que las carpetas de fotos: estilo (letras+números) + talla (letras) + color (2 o 3 dígitos).
const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;
const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const key = (s) => String(s || '').trim().toUpperCase();

/** Agrupa por estilo los simples con SKU de variación. */
function findOrphans(products) {
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [key(p.sku), p]));
  const groups = new Map();
  for (const p of products) {
    if (p.type !== 'simple') continue;
    const m = key(p.sku).match(SKU_PARTS);
    if (!m) continue;
    const [, style, talla, color] = m;
    if (!groups.has(style)) groups.set(style, []);
    groups.get(style).push({ id: p.id, sku: p.sku, name: p.name, talla, color, status: STATUS[p.status] || p.status, url: p.permalink || null });
  }

  const out = [];
  for (const [style, items] of groups) {
    const parent = bySku.get(style);
    // Un simple solo y sin padre suele ser legítimo (ej. bolsa de talla única "OS").
    if (items.length < 2 && !parent) continue;
    out.push({
      style,
      parent: parent ? { id: parent.id, sku: parent.sku, name: parent.name, type: parent.type === 'variable' ? 'Variable' : 'Simple', url: parent.permalink || null } : null,
      items: items.sort((a, b) => a.sku.localeCompare(b.sku)),
    });
  }
  return out.sort((a, b) => b.items.length - a.items.length || a.style.localeCompare(b.style));
}

async function buildReport() {
  const groups = findOrphans(await store.fetchProductsLite());
  return {
    updatedAt: new Date().toISOString(),
    groups,
    totals: {
      estilos: groups.length,
      productos: groups.reduce((n, g) => n + g.items.length, 0),
      conPadreVariable: groups.filter((g) => g.parent?.type === 'Variable').length,
    },
  };
}

// Se calcula en segundo plano (leer todos los productos tarda) y se guarda el último resultado.
let cache = null;
let running = null;

function getReport() {
  return { report: cache, refreshing: Boolean(running) };
}

function refreshReport() {
  if (!running) {
    running = buildReport()
      .then((r) => { cache = r; })
      .catch((error) => { cache = { ...(cache || {}), error: error.message, updatedAt: new Date().toISOString() }; })
      .finally(() => { running = null; });
  }
  return running;
}

module.exports = { findOrphans, getReport, refreshReport };
