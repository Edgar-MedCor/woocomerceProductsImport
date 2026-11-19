// Reporte de "variantes sueltas". Lo correcto es UN producto Variable por modelo
// (SKU del estilo, ej. RD49432) con todas sus variaciones de color y talla. Detecta:
//   - Productos simples cuyo SKU tiene forma de variación (estilo + talla + color,
//     ej. RD49432 + OM + 005).
//   - Productos Variables "por color": su SKU es estilo + color (ej. RD49432005) y
//     sus variaciones son solo las tallas de ese color (RD49432S005, RD49432M005…).
//     Deberían ser colores dentro del Variable del modelo.
// Solo lee; no modifica nada.
const store = require('../woo/store');

// Misma convención que las carpetas de fotos: estilo (letras+números) + talla (letras) + color (2 o 3 dígitos).
const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;
const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const key = (s) => String(s || '').trim().toUpperCase();
const isColorAttr = (a) => /^(color|colour|pa_color)$/i.test(String(a?.name || a?.slug || '').trim());

/**
 * Variables que podrían ser "por color" (vale la pena consultar sus variaciones):
 * SKU de letras + números y sin varios colores (un modelo bien armado tiene varios).
 */
function colorParentCandidates(products) {
  return products.filter((p) => p.type === 'variable' && /^[A-Z]+\d+$/.test(key(p.sku))
    && (p.attributes || []).filter(isColorAttr).every((a) => (a.options || []).length <= 1));
}

/**
 * ¿Es un Variable por color? Sí, si sus variaciones tienen SKU estilo + talla + color
 * con el mismo estilo y color, y el SKU del padre es justo estilo + color.
 * Devuelve { style, color, tallas, variaciones } o null.
 */
function asColorParent(product, variations) {
  const parsed = (variations || []).map((v) => key(v.sku).match(SKU_PARTS)).filter(Boolean);
  if (!parsed.length) return null;
  const [, style, , color] = parsed[0];
  if (parsed.some(([, s, , c]) => s !== style || c !== color)) return null;
  // SKU del padre = estilo + un color (a veces no coincide con el de sus variaciones, ej. RD46607025 con tallas del 012).
  const own = key(product.sku);
  if (!own.startsWith(style) || !/^\d{2,3}$/.test(own.slice(style.length))) return null;
  return { style, color, tallas: [...new Set(parsed.map(([, , t]) => t))], variaciones: variations.length };
}

/**
 * Agrupa por estilo los simples con SKU de variación y los Variables por color.
 * `variationsByParent`: Map(ID del Variable -> sus variaciones) de los candidatos.
 */
function findOrphans(products, variationsByParent = new Map()) {
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [key(p.sku), p]));
  const groups = new Map();
  for (const p of products) {
    if (p.type !== 'simple') continue;
    const m = key(p.sku).match(SKU_PARTS);
    if (!m) continue;
    const [, style, talla, color] = m;
    if (!groups.has(style)) groups.set(style, []);
    groups.get(style).push({ id: p.id, sku: p.sku, name: p.name, kind: 'simple', talla, color, status: STATUS[p.status] || p.status, url: p.permalink || null });
  }
  for (const p of products) {
    if (p.type !== 'variable' || !variationsByParent.has(p.id)) continue;
    const cp = asColorParent(p, variationsByParent.get(p.id));
    if (!cp) continue;
    if (!groups.has(cp.style)) groups.set(cp.style, []);
    groups.get(cp.style).push({
      id: p.id, sku: p.sku, name: p.name, kind: 'variable', talla: null, color: cp.color, tallas: cp.tallas, variaciones: cp.variaciones,
      status: STATUS[p.status] || p.status, url: p.permalink || null,
    });
  }

  const out = [];
  for (const [style, items] of groups) {
    const parent = bySku.get(style);
    // Un simple solo y sin padre suele ser legítimo (ej. bolsa de talla única "OS").
    // Un Variable por color siempre se reporta: su modelo debería ser el padre.
    if (items.length < 2 && !parent && !items.some((i) => i.kind === 'variable')) continue;
    out.push({
      style,
      parent: parent ? { id: parent.id, sku: parent.sku, name: parent.name, type: parent.type === 'variable' ? 'Variable' : 'Simple', url: parent.permalink || null } : null,
      items: items.sort((a, b) => a.sku.localeCompare(b.sku)),
    });
  }
  return out.sort((a, b) => b.items.length - a.items.length || a.style.localeCompare(b.style));
}

async function buildReport() {
  const products = await store.fetchProductsForOrphans();
  // Solo se consultan las variaciones de los candidatos (no de toda la tienda).
  const variationsByParent = new Map();
  for (const p of colorParentCandidates(products)) {
    variationsByParent.set(p.id, await store.fetchVariationSkus(p.id));
  }
  const groups = findOrphans(products, variationsByParent);
  return {
    updatedAt: new Date().toISOString(),
    groups,
    totals: {
      estilos: groups.length,
      productos: groups.reduce((n, g) => n + g.items.filter((i) => i.kind === 'simple').length, 0),
      padresPorColor: groups.reduce((n, g) => n + g.items.filter((i) => i.kind === 'variable').length, 0),
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

module.exports = { findOrphans, colorParentCandidates, asColorParent, getReport, refreshReport };
