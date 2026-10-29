// Reparación de atributos de los productos variables que ya están en la tienda:
// Color y Talla (salvo Unitalla) para variaciones, los demás no, y todos globales (attributeRules.js).
// Paso 1 solo lee y arma la lista; paso 2 la aplica. Solo toca los atributos.
const config = require('../config');
const store = require('../woo/store');
const { applyRule, attributePayload, shouldVary, hasColor } = require('../push/attributeRules');

const BATCH = 20;
const PAUSE_MS = 1500; // respiro entre lotes para que el hosting no corte por exceso de peticiones
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const adminUrl = (id) => `${config.woo.url().replace(/\/$/, '')}/wp-admin/post.php?post=${id}&action=edit`;
const attrSummary = (list) => list.map((a) => `${a.name}${a.id ? '' : ' (local)'}: ${a.variation ? 'para variaciones' : 'no'}`).join('; ');

/** Paso 1: qué productos no cumplen la regla y cómo quedarían. */
async function reviewAttributes({ log = console.log, progress = () => {} } = {}) {
  log('Leyendo los productos variables de la tienda…');
  const [{ attributes: globals }, products] = await Promise.all([store.fetchTaxonomies(), store.fetchVariableProducts()]);
  log(`${products.length} productos variables leídos.`);

  const empty = products.filter((p) => !p.variations?.length);
  const candidates = products.filter((p) => p.variations?.length);
  const items = [];
  let done = 0;
  for (const p of candidates) {
    // Solo se consultan las variaciones si hay que decidir si un atributo prendido se puede apagar.
    const others = p.attributes.filter((a) => a.variation && !shouldVary(a.name, a.options, hasColor(p.attributes)));
    let variations = [];
    if (others.length) variations = await store.fetchAllVariations(p.id);
    // Solo importa si distingue variaciones: con el mismo valor en todas, apagarlo no cambia nada.
    const usedByVariations = (attr) => new Set(variations.flatMap((v) => v.attributes
      .filter((va) => (attr.id ? va.id === attr.id : va.name === attr.name) && va.option)
      .map((va) => va.option.toLowerCase()))).size > 1;
    const { attributes, changes, warnings } = applyRule(p.attributes, globals, usedByVariations);
    if (changes.length || warnings.length) {
      items.push({ id: p.id, sku: p.sku, name: p.name, status: STATUS[p.status] || p.status, url: p.permalink || null, variations: p.variations.length, before: p.attributes, attributes, changes, warnings });
    }
    done += 1;
    if (done % 25 === 0 || done === candidates.length) progress(done, candidates.length, 'Productos revisados');
  }

  const toFix = items.filter((i) => i.changes.length);
  return {
    reviewedAt: Date.now(),
    items,
    empty: empty.map((p) => p.sku || `ID ${p.id}`),
    summary: {
      'Productos variables revisados': products.length,
      'Productos a corregir': toFix.length,
      'Atributos que se prenden para variaciones': toFix.reduce((n, i) => n + i.changes.filter((c) => c.to === 'Se usa para variaciones').length, 0),
      'Atributos que se apagan para variaciones': toFix.reduce((n, i) => n + i.changes.filter((c) => c.to === 'No se usa para variaciones').length, 0),
      'Atributos locales que pasan a globales': toFix.reduce((n, i) => n + i.changes.filter((c) => c.from === 'Local').length, 0),
      'Con avisos (revisar a mano)': items.filter((i) => i.warnings.length).length,
      'Variables sin variaciones (no se tocan)': empty.length,
    },
  };
}

/** Paso 2: guarda los atributos corregidos, en lotes. */
async function applyAttributes(review, { log = console.log, progress = () => {} } = {}) {
  const items = review.items.filter((i) => i.changes.length);
  let done = 0;
  for (const part of chunk(items, BATCH)) {
    try {
      // Es una actualización idempotente: se puede reintentar si la tienda pide esperar (429) o falla.
      const res = await store.request('post', 'products/batch', { update: part.map((i) => ({ id: i.id, attributes: attributePayload(i.attributes) })) });
      part.forEach((item, n) => {
        const r = (res.data.update || [])[n];
        item.result = r && !r.error ? { ok: true, message: 'Atributos corregidos' } : { ok: false, message: r?.error?.message || 'Sin respuesta de la tienda' };
      });
    } catch (error) {
      part.forEach((item) => { item.result = { ok: false, message: error.response?.data?.message || error.message }; });
    }
    for (const item of part) log(`${item.result.ok ? '✔' : '✖'} ${item.sku}: ${item.result.message}`);
    done += part.length;
    progress(done, items.length, 'Productos corregidos');
    if (done < items.length) await sleep(PAUSE_MS);
  }
  const ok = items.filter((i) => i.result.ok).length;
  return { summary: { 'Productos corregidos': ok, 'Con error': items.length - ok } };
}

// Formato de la tabla de revisión del panel (mismo que "Revisar cambios").
function publicAttributes(review, { withResults = false } = {}) {
  const shown = review.empty.slice(0, 40).join(', ');
  return {
    summary: review.summary,
    notes: review.empty.length
      ? [`${review.empty.length} producto(s) Variable no tienen variaciones y no se tocan (casi siempre son variantes sueltas): ${shown}${review.empty.length > 40 ? '…' : ''}`]
      : [],
    items: review.items.map((i) => ({
      row: i.id,
      kind: 'update',
      type: 'Variable',
      id: i.id,
      sku: i.sku,
      name: i.name,
      attributes: `${i.status} · ${i.variations} variación(es)`,
      changes: i.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
      conflicts: [],
      skipped: [],
      errors: [],
      warnings: i.warnings,
    })),
    results: withResults
      ? review.items.filter((i) => i.result).map((i) => ({ row: i.id, sku: i.sku, ok: i.result.ok, message: i.result.message, url: i.url, adminUrl: adminUrl(i.id) }))
      : undefined,
  };
}

module.exports = { reviewAttributes, applyAttributes, publicAttributes, attrSummary };
