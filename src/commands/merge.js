// "Juntar modelos" (solo administrador): corrige en la tienda las variantes sueltas
// del reporte. Por estilo:
//   - Varios colores sin padre: se crea un producto Variable nuevo con el SKU del
//     estilo, con todas las variaciones de color y talla; las variaciones viejas y
//     los productos por color (o simples) van a la papelera.
//   - Ya existe el Variable del estilo: los colores sueltos pasan a ser variaciones de él.
//   - Un solo color (Variable con SKU estilo + color): solo cambia su SKU al del estilo.
// Paso 1 (reviewMerge) solo lee y arma el plan; paso 2 (applyMerge) lo aplica con
// respaldo en push_backups, así "Deshacer" lo puede revertir como un push.
const config = require('../config');
const store = require('../woo/store');
const trash = require('../push/trash');
const { pick } = require('../push/backup');
const { shouldVary } = require('../push/attributeRules');
const { findOrphans, colorParentCandidates } = require('../report/orphans');

const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;
const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const PAUSE_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => String(s || '').trim().toUpperCase();
const plain = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const isAttr = (a, name) => plain(a?.name) === name || plain(String(a?.slug || '').replace(/^pa_/, '')) === name;
const attrOf = (obj, name) => (obj?.attributes || []).find((a) => isAttr(a, name));
const optionOf = (variation, name) => attrOf(variation, name)?.option || null;
const adminUrl = (id) => `${config.woo.url().replace(/\/$/, '')}/wp-admin/post.php?post=${id}&action=edit`;
const uniq = (list) => [...new Set(list.filter((x) => x !== null && x !== undefined && x !== ''))];
const uniqBy = (list, fn) => { const seen = new Set(); return list.filter((x) => { const k = fn(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

// Orden de tallas para la lista del atributo (las desconocidas van al final, en orden alfabético).
const SIZE_ORDER = ['xch', 'ch', 's', 'ch/m', 'm', 'g', 'l', 'g/eg', 'eg', 'xl', 'eeg', 'xxl', 'unitalla'];
const sizeRank = (t) => { const i = SIZE_ORDER.indexOf(plain(t)); return i < 0 ? SIZE_ORDER.length : i; };
const sortSizes = (list) => [...list].sort((a, b) => sizeRank(a) - sizeRank(b) || a.localeCompare(b));

// Igual que WordPress (sanitize_title) para los casos comunes: sin acentos, minúsculas y guiones.
const slugify = (name) => plain(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// "VESTIDO LARGO DE TIRANTES" -> "Vestido Largo de Tirantes".
const SMALL_WORDS = new Set(['de', 'del', 'con', 'y', 'en', 'a', 'la', 'el', 'las', 'los', 'para', 'por', 'sin', 'c/']);
function titleCase(name) {
  return name.toLowerCase().split(/\s+/).map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
const isAllCaps = (s) => /[A-ZÁÉÍÓÚÑ]/.test(s) && s === s.toUpperCase();

/** Nombre del modelo: el de un color sin el nombre del color ("Vestido Umbrella Turquesa Liso" -> "Vestido Umbrella Liso"). */
function modelName(names, colors) {
  const base = names.find((n) => n && !isAllCaps(n)) || names.find(Boolean) || '';
  const words = base.trim().split(/\s+/);
  const plainWords = words.map(plain);
  const drop = new Set();
  for (const color of colors) {
    const c = plain(color).split(/\s+/).filter(Boolean);
    if (!c.length) continue;
    for (let i = 0; i + c.length <= words.length; i += 1) {
      if (c.every((w, j) => plainWords[i + j] === w)) c.forEach((_, j) => drop.add(i + j));
    }
  }
  let out = words.filter((_, i) => !drop.has(i)).join(' ').trim();
  out = out.replace(/\s+(de|en|color)$/i, '').trim();
  if (!out) out = base.trim();
  return isAllCaps(out) ? titleCase(out) : out;
}

/**
 * Nombre más usado en la tienda para cada código del SKU, aprendido de las variaciones:
 * part 2 = talla (SM -> CH/M, LXL -> G/EG, OS -> Unitalla…), part 3 = color (002 -> Negro…).
 */
function learnCodes(entries, part, field) {
  const counts = new Map();
  for (const e of entries) {
    const m = key(e.sku).match(SKU_PARTS);
    if (!m || !e[field]) continue;
    const code = m[part];
    if (!counts.has(code)) counts.set(code, new Map());
    counts.get(code).set(e[field], (counts.get(code).get(e[field]) || 0) + 1);
  }
  return new Map([...counts].map(([code, byName]) => [code, [...byName].sort((a, b) => b[1] - a[1])[0][0]]));
}
const learnSizes = (entries) => learnCodes(entries, 2, 'talla');
const learnColors = (entries) => learnCodes(entries, 3, 'color');
const colorCode = (sku) => key(sku).match(SKU_PARTS)?.[3] || null;

// Color de un producto por color o de un simple: su atributo Color (o el de sus variaciones).
function colorOfProduct(product, variations = []) {
  const own = attrOf(product, 'color')?.options || [];
  if (own.length === 1) return own[0];
  const fromVariations = uniq(variations.map((v) => optionOf(v, 'color')));
  return fromVariations.length === 1 ? fromVariations[0] : null;
}

function tallaOf(sku, explicit, parentOptions, sizes) {
  if (explicit) return explicit;
  if ((parentOptions || []).length === 1) return parentOptions[0];
  const m = key(sku).match(SKU_PARTS);
  return m ? sizes.get(m[2]) || null : null;
}

const META_KEEP = /^wayan_/;
const keepMeta = (obj) => (obj.meta_data || []).filter((m) => META_KEEP.test(m.key)).map((m) => ({ key: m.key, value: m.value }));

// Datos de una variación nueva a partir de la variación vieja (o del simple) que reemplaza.
function variationPayload(entry, attributes) {
  const src = entry.source === 'variation' ? entry.variation : entry.product;
  const image = entry.source === 'variation' ? (src.image?.id ? src.image.id : entry.product.images?.[0]?.id) : src.images?.[0]?.id;
  const payload = {
    sku: entry.sku,
    status: entry.source === 'variation' ? (src.status === 'private' ? 'private' : 'publish') : (src.status === 'publish' ? 'publish' : 'private'),
    regular_price: src.regular_price || '',
    sale_price: src.sale_price || '',
    date_on_sale_from: src.sale_price ? src.date_on_sale_from || '' : '',
    date_on_sale_to: src.sale_price ? src.date_on_sale_to || '' : '',
    manage_stock: src.manage_stock === true,
    stock_status: src.stock_status || 'instock',
    backorders: src.backorders || 'no',
    weight: src.weight || '',
    dimensions: src.dimensions || { length: '', width: '', height: '' },
    shipping_class: src.shipping_class || '',
    tax_class: src.tax_class || '',
    description: entry.source === 'variation' ? src.description || '' : '',
    attributes,
    meta_data: keepMeta(src),
  };
  if (payload.manage_stock) payload.stock_quantity = src.stock_quantity ?? 0;
  if (image) payload.image = { id: image };
  return payload;
}

// Las variaciones solo se distinguen por Color y Talla.
const variationAttrs = (entry, model) => model.attributes
  .filter((a) => a.variation && (isAttr(a, 'color') || isAttr(a, 'talla')))
  .map((a) => ({ id: a.id, option: isAttr(a, 'color') ? entry.color : entry.talla }));

/**
 * Plan de un estilo del reporte. `ctx` = { products: Map(id -> producto completo),
 * variations: Map(id del Variable -> variaciones), sizes, taken: Set(SKU ocupados), slugs: Set(slugs ocupados), globals }.
 */
function planGroup(group, ctx) {
  const plan = { style: group.style, errors: [], warnings: [], entries: [], trashProducts: [], mode: null };
  const fail = (msg) => plan.errors.push(msg);
  const items = group.items.map((i) => ({ ...i, product: ctx.products.get(i.id) })).filter((i) => {
    if (!i.product) fail(`${i.sku} ya no está en la tienda. Actualiza el reporte.`);
    return i.product;
  });
  const parent = group.parent ? ctx.products.get(group.parent.id) : null;
  if (group.parent && !parent) fail(`El padre ${group.parent.sku} ya no está en la tienda. Actualiza el reporte.`);
  if (parent && parent.type !== 'variable') fail(`El padre ${parent.sku} es ${parent.type === 'simple' ? 'Simple' : parent.type}: cámbialo a Variable a mano y vuelve a revisar.`);
  plan.sources = items.map((i) => ({ id: i.id, sku: i.product.sku, name: i.product.name, kind: i.kind, status: STATUS[i.product.status] || i.product.status, url: i.product.permalink || null }));

  // Un solo color, sin padre: solo se le pone el SKU del estilo.
  if (!parent && items.length === 1 && items[0].kind === 'variable') {
    plan.mode = 'rename';
    const p = items[0].product;
    plan.rename = { id: p.id, from: p.sku, to: group.style, name: p.name, url: p.permalink || null };
    plan.modelName = p.name;
    plan.finalUrl = p.permalink || null;
    if (ctx.taken.has(key(group.style))) fail(`El SKU ${group.style} ya lo usa otro producto (o uno en la papelera). Revísalo a mano.`);
    return plan;
  }

  // Lo que pasa al modelo: variaciones de los Variables por color y los simples.
  const left = []; // variaciones vacías o desactivadas que no se pasan (se van a la papelera con su producto)
  for (const i of items) {
    const p = i.product;
    if (i.kind === 'variable') {
      const all = (ctx.variations.get(p.id) || []).filter((v) => v.status !== 'trash');
      // Solo pasan las que tienen SKU de variación (estilo + talla + color). Las demás activas son un error;
      // las desactivadas o a medias ("inherit", sin precio) son restos y se quedan con el producto anterior.
      const variations = all.filter((v) => SKU_PARTS.test(key(v.sku)));
      for (const v of all.filter((x) => !variations.includes(x))) {
        if (v.status === 'publish' && v.regular_price) fail(`La variación activa ${v.sku || `ID ${v.id}`} de ${p.sku} no tiene SKU de talla y color. Corrígela a mano.`);
        else left.push(v.sku || `ID ${v.id}`);
      }
      const color = colorOfProduct(p, variations);
      const tallas = attrOf(p, 'talla')?.options || [];
      if (!variations.length) fail(`${p.sku} no tiene variaciones con SKU de talla y color.`);
      for (const v of variations) {
        const vColor = optionOf(v, 'color') || color || ctx.colors.get(colorCode(v.sku));
        const talla = tallaOf(v.sku, optionOf(v, 'talla'), tallas, ctx.sizes);
        if (!vColor) fail(`No se sabe el nombre del color de ${v.sku}: ponle el atributo Color a ${p.sku}.`);
        if (!talla) fail(`No se sabe la talla de ${v.sku}: ponle el atributo Talla.`);
        plan.entries.push({ source: 'variation', product: p, variation: v, sku: v.sku, color: vColor, talla });
      }
      plan.trashProducts.push(p);
    } else {
      const color = colorOfProduct(p) || ctx.colors.get(colorCode(p.sku));
      const talla = tallaOf(p.sku, null, attrOf(p, 'talla')?.options, ctx.sizes);
      if (!color) fail(`No se sabe el nombre del color de ${p.sku}: ponle el atributo Color.`);
      if (!talla) fail(`No se sabe la talla de ${p.sku}: ponle el atributo Talla.`);
      plan.entries.push({ source: 'simple', product: p, sku: p.sku, color, talla });
    }
  }
  if (left.length) plan.warnings.push(`${left.length} variación(es) vacías o desactivadas sin SKU de talla y color no se pasan; se van a la papelera con su producto: ${uniq(left).join(', ')}.`);

  // Variaciones que ya tiene el padre existente (se conservan; si no tienen color, se les pone el del padre).
  // (Las que no tienen SKU de talla y color se dejan como están.)
  const ownVariations = parent ? (ctx.variations.get(parent.id) || []).filter((v) => v.status !== 'trash' && SKU_PARTS.test(key(v.sku))) : [];
  const parentColors = attrOf(parent, 'color')?.options || [];
  plan.parentFixes = [];
  if (parent) {
    const parentColor = parentColors.length === 1 ? parentColors[0] : colorOfProduct(parent, ownVariations);
    for (const v of ownVariations) {
      const color = optionOf(v, 'color');
      const talla = tallaOf(v.sku, optionOf(v, 'talla'), attrOf(parent, 'talla')?.options, ctx.sizes);
      if (!color && !parentColor) fail(`Las variaciones de ${parent.sku} no tienen color y el padre no dice cuál es: ponle el atributo Color a ${parent.sku}.`);
      if (!talla) fail(`No se sabe la talla de ${v.sku || `ID ${v.id}`} (de ${parent.sku}).`);
      plan.parentFixes.push({ variation: v, color: color || parentColor, talla, needsUpdate: !color || !optionOf(v, 'talla') });
    }
  }

  // Un mismo nombre de color en dos códigos distintos casi siempre es un atributo copiado de otro producto
  // (ej. "azul marino" 017 con Color "Negro"): a esos se les pone el nombre que usa la tienda para su código.
  const withCode = [...plan.parentFixes, ...plan.entries].map((e) => ({ e, code: colorCode(e.sku || e.variation?.sku) }));
  const codesByColor = new Map();
  for (const { e, code } of withCode) {
    if (!e.color || !code) continue;
    if (!codesByColor.has(plain(e.color))) codesByColor.set(plain(e.color), new Set());
    codesByColor.get(plain(e.color)).add(code);
  }
  const fixedCodes = new Map();
  for (const { e, code } of withCode) {
    if (!e.color || !code || codesByColor.get(plain(e.color)).size < 2) continue;
    const known = ctx.colors.get(code);
    if (known && plain(known) !== plain(e.color)) {
      fixedCodes.set(code, `${e.color} → ${known}`);
      e.color = known;
      if (e.variation && plan.parentFixes.includes(e)) e.needsUpdate = true;
    }
  }
  for (const [code, change] of fixedCodes) plan.warnings.push(`El color ${code} tenía el atributo de otro color: se usa el nombre que tiene ese código en la tienda (${change}).`);

  // Nada se puede repetir dentro del modelo: ni color + talla ni SKU.
  const all = [...plan.parentFixes.map((f) => ({ sku: f.variation.sku, color: f.color, talla: f.talla })), ...plan.entries];
  const combos = new Map();
  for (const e of all) {
    const k = `${plain(e.color)}|${plain(e.talla)}`;
    if (e.color && e.talla && combos.has(k)) fail(`${e.sku} y ${combos.get(k)} serían la misma variación (${e.color} · ${e.talla}). Revísalos a mano.`);
    combos.set(k, e.sku);
  }
  const skus = all.map((e) => key(e.sku)).filter(Boolean);
  const dup = skus.find((s, i) => skus.indexOf(s) !== i);
  if (dup) fail(`El SKU ${dup} está repetido en este estilo.`);

  const colors = uniq(all.map((e) => e.color));
  const tallas = sortSizes(uniq(all.map((e) => e.talla)));
  const colorAttr = ctx.globals.color;
  const tallaAttr = ctx.globals.talla;
  if (!colorAttr || !tallaAttr) fail('No existen los atributos globales Color y Talla en la tienda.');
  const varyTalla = shouldVary('talla', tallas, true);
  const coreAttrs = [
    { id: colorAttr?.id, name: colorAttr?.name, options: colors, visible: true, variation: true, position: 0 },
    { id: tallaAttr?.id, name: tallaAttr?.name, options: tallas, visible: true, variation: varyTalla, position: 1 },
  ];

  if (parent) {
    plan.mode = 'into-parent';
    plan.modelName = parent.name;
    plan.finalUrl = parent.permalink || null;
    plan.parent = parent;
    const others = (parent.attributes || []).filter((a) => !isAttr(a, 'color') && !isAttr(a, 'talla'));
    // Colores que ya tenía el padre y no usa ninguna variación también se conservan.
    coreAttrs[0].options = uniq([...parentColors, ...colors]);
    coreAttrs[1].options = sortSizes(uniq([...(attrOf(parent, 'talla')?.options || []), ...tallas]));
    coreAttrs[1].variation = shouldVary('talla', coreAttrs[1].options, true);
    plan.attributes = [...coreAttrs, ...others.map((a, n) => ({ ...a, position: n + 2 }))];
    if (!plan.entries.length) fail('No hay nada que pasar al padre.');
  } else {
    plan.mode = 'merge';
    // El producto base (descripción, categorías, fotos): el publicado con más fotos.
    const bases = [...items].sort((a, b) => (b.product.status === 'publish') - (a.product.status === 'publish')
      || (b.kind === 'variable') - (a.kind === 'variable') || (b.product.images?.length || 0) - (a.product.images?.length || 0) || a.product.sku.localeCompare(b.product.sku));
    const base = bases[0]?.product;
    plan.base = base;
    plan.modelName = modelName(bases.map((b) => b.product.name), colors);
    const others = (base?.attributes || []).filter((a) => !isAttr(a, 'color') && !isAttr(a, 'talla'));
    // En el modelo nuevo solo Color y Talla son para variaciones (Material, Técnica… no).
    plan.attributes = [...coreAttrs, ...others.map((a, n) => ({ ...a, variation: false, position: n + 2 }))];
    if (ctx.taken.has(key(group.style))) fail(`El SKU ${group.style} ya lo usa otro producto (o uno en la papelera). Revísalo a mano.`);
    plan.urlBase = base?.permalink ? base.permalink.replace(/[^/]+\/?$/, '') : null;
    plan.status = items.some((i) => i.product.status === 'publish') ? 'publish' : base?.status || 'draft';
  }

  // Nombres muy distintos suelen ser productos distintos con el mismo estilo.
  const firstWords = uniq(items.map((i) => plain(i.product.name).split(/\s+/)[0]));
  plan.doubt = firstWords.length > 1;
  if (plan.doubt) plan.warnings.push(`Los nombres empiezan distinto (${uniq(items.map((i) => i.product.name)).join(' / ')}): confirma que sí son el mismo modelo.`);
  if (plan.mode === 'merge' && items.every((i) => i.kind === 'simple')) plan.warnings.push('Solo hay productos simples: se crea el modelo con ellos como variaciones.');
  return plan;
}

// URL que tendrá el modelo nuevo (WordPress agrega -2, -3… si el slug ya está ocupado).
function finalUrl(plan, name, slugsTaken) {
  if (plan.mode !== 'merge') return plan.finalUrl;
  const base = slugify(name);
  let slug = base;
  for (let n = 2; slugsTaken.has(slug); n += 1) slug = `${base}-${n}`;
  return plan.urlBase ? `${plan.urlBase}${slug}/` : null;
}

/** Paso 1: arma el plan de todos los estilos del reporte. Solo lee. */
async function reviewMerge({ log = console.log, progress = () => {} } = {}) {
  log('Leyendo los productos de la tienda…');
  const [lite, { attributes: globals }] = await Promise.all([store.fetchProductsForOrphans(), store.fetchTaxonomies()]);
  const candidates = colorParentCandidates(lite);
  const variationsByParent = new Map();
  let done = 0;
  for (const p of candidates) {
    variationsByParent.set(p.id, await store.fetchVariationSkus(p.id));
    done += 1;
    if (done % 20 === 0 || done === candidates.length) progress(done, candidates.length, 'Revisando productos por color');
  }
  const groups = findOrphans(lite, variationsByParent);
  log(`${groups.length} estilo(s) con variantes sueltas. Leyendo sus datos completos…`);

  const ids = uniq(groups.flatMap((g) => [...g.items.map((i) => i.id), g.parent?.id]));
  const products = new Map((await store.fetchProductsByIds(ids)).map((p) => [p.id, p]));
  const variations = new Map();
  const variables = [...products.values()].filter((p) => p.type === 'variable');
  done = 0;
  for (const p of variables) {
    variations.set(p.id, await store.fetchAllVariations(p.id));
    done += 1;
    if (done % 10 === 0 || done === variables.length) progress(done, variables.length, 'Leyendo variaciones');
  }

  // Tallas por código, aprendidas de las variaciones y simples de la tienda.
  const sizeEntries = [
    ...[...variationsByParent.values(), ...variations.values()].flat().map((v) => ({ sku: v.sku, talla: optionOf(v, 'talla') })),
    ...[...products.values()].filter((p) => p.type === 'simple').map((p) => ({ sku: p.sku, talla: (attrOf(p, 'talla')?.options || []).length === 1 ? attrOf(p, 'talla').options[0] : null })),
  ];
  const sizes = learnSizes(sizeEntries);
  const colors = learnColors([...variationsByParent.values(), ...variations.values()].flat().map((v) => ({ sku: v.sku, color: optionOf(v, 'color') })));
  const findGlobal = (name) => (globals || []).find((g) => plain(g.name) === name || plain(String(g.slug || '').replace(/^pa_/, '')) === name);

  // SKU del estilo ocupado (también en la papelera) y slugs ocupados (para la URL final).
  const styles = groups.filter((g) => !g.parent).map((g) => g.style);
  const taken = new Set((styles.length ? await store.fetchProductsBySkus(styles) : []).map((p) => key(p.sku)));
  const slugsTaken = new Set(lite.map((p) => (p.permalink || '').replace(/\/$/, '').split('/').pop()).filter(Boolean));

  const ctx = { products, variations, sizes, colors, taken, globals: { color: findGlobal('color'), talla: findGlobal('talla') } };
  const plans = groups.map((g) => planGroup(g, ctx));
  for (const p of plans) p.url = finalUrl(p, p.modelName, slugsTaken);

  return { reviewedAt: Date.now(), plans, slugsTaken, summary: summarize(plans) };
}

function summarize(plans, selected = null) {
  const ok = plans.filter((p) => !p.errors.length && (!selected || selected.has(p.style)));
  return {
    'Modelos nuevos (se juntan los colores)': ok.filter((p) => p.mode === 'merge').length,
    'Estilos que pasan a su padre Variable': ok.filter((p) => p.mode === 'into-parent').length,
    'Productos de un color (solo cambia el SKU)': ok.filter((p) => p.mode === 'rename').length,
    'Variaciones que pasan al modelo': ok.reduce((n, p) => n + p.entries.length, 0),
    'Productos que van a la papelera': ok.reduce((n, p) => n + p.trashProducts.length + p.entries.filter((e) => e.source === 'simple').length, 0),
    'Con errores (no se tocan)': plans.filter((p) => p.errors.length).length,
  };
}

// ---------- paso 2: aplicar ----------

async function saveRow(pool, runId, row) {
  await pool.query(
    `INSERT INTO push_backups (run_id, kind, action, woo_id, parent_id, sku, fields, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, row.kind, row.action, row.wooId, row.parentId ?? null, row.sku ?? null, JSON.stringify(row.fields || []), row.before ? JSON.stringify(row.before) : null, row.after ? JSON.stringify(row.after) : null],
  );
}

const attributePayload = (list) => list.map(({ id, name, options, visible, variation, position }) => (id
  ? { id, options, visible, variation, position }
  : { name, options, visible, variation, position }));

// Manda a la papelera las fuentes (variaciones viejas y simples) liberando su SKU.
// Si una falla, trashVariation/trashProduct regresan esa misma; las anteriores quedan marcadas en `e.trashed`.
async function trashSources(plan) {
  for (const e of plan.entries) {
    if (e.source === 'variation') {
      const snap = trash.snapshotVariation(e.variation, e.product);
      await trash.trashVariation(snap, { clearSku: true });
      e.trashed = snap;
    } else {
      const snap = await trash.snapshotProduct(e.product);
      await trash.trashProduct(snap, { clearSku: true });
      e.trashed = snap;
    }
  }
}

async function restoreSource(e) {
  if (e.source === 'variation') await trash.restoreVariation(e.trashed);
  else await trash.restoreProduct(e.trashed);
  e.trashed = null;
}

/**
 * Aplica un estilo. Las filas de respaldo se agregan a `backups` en el orden en que
 * "Deshacer" las necesita: lo creado primero, luego lo modificado y lo de la papelera.
 */
async function applyGroup(plan, name, { log }) {
  const backups = [];
  const result = { ok: false, message: '', url: null, adminUrl: null, moved: 0 };
  const done = (ok, message, extra = {}) => Object.assign(result, { ok, message, ...extra });

  if (plan.mode === 'rename') {
    const r = plan.rename;
    const res = await store.batch('products', { update: [{ id: r.id, sku: r.to }] });
    const u = res.update[0];
    if (!u.ok) return { result: done(false, `No se pudo cambiar el SKU: ${u.error}`), backups };
    backups.push({ kind: 'product', action: 'update', wooId: r.id, sku: r.to, fields: ['sku'], before: { sku: r.from }, after: { sku: pick(u.data, 'sku') } });
    return { result: done(true, `SKU cambiado de ${r.from} a ${r.to}`, { url: u.data.permalink || r.url, adminUrl: adminUrl(r.id) }), backups };
  }

  // 1. El modelo: se crea (o se le actualizan los atributos al padre existente).
  let modelId;
  let model;
  if (plan.mode === 'merge') {
    const b = plan.base;
    const items = plan.trashProducts.concat(plan.entries.filter((e) => e.source === 'simple').map((e) => e.product));
    const images = uniqBy([...(b.images || []), ...items.map((p) => p.images?.[0]).filter(Boolean)], (img) => img.id).slice(0, 15);
    const payload = {
      name,
      type: 'variable',
      sku: plan.style,
      status: plan.status,
      catalog_visibility: b.catalog_visibility || 'visible',
      featured: Boolean(b.featured),
      categories: uniqBy(items.flatMap((p) => p.categories || []), (c) => c.id).map((c) => ({ id: c.id })),
      tags: uniqBy(items.flatMap((p) => p.tags || []), (t) => t.id).map((t) => ({ id: t.id })),
      short_description: b.short_description || '',
      description: b.description || '',
      images: images.map((img) => ({ id: img.id })),
      attributes: attributePayload(plan.attributes),
      default_attributes: [],
      weight: b.weight || '',
      dimensions: b.dimensions || { length: '', width: '', height: '' },
      shipping_class: b.shipping_class || '',
      tax_status: b.tax_status || 'taxable',
      tax_class: b.tax_class || '',
      meta_data: keepMeta(b),
    };
    if (Array.isArray(b.brands)) payload.brands = uniqBy(items.flatMap((p) => p.brands || []), (x) => x.id).map((x) => ({ id: x.id }));
    log(`${plan.style}: creando el modelo "${name}"…`);
    const res = await store.batch('products', { create: [payload] });
    const c = res.create[0];
    if (!c.ok) return { result: done(false, `No se pudo crear el modelo: ${c.error}`), backups };
    model = c.data;
    modelId = model.id;
    backups.push({ kind: 'product', action: 'create', wooId: modelId, sku: plan.style, after: { date_modified: model.date_modified || null } });
  } else {
    model = plan.parent;
    modelId = model.id;
    const res = await store.batch('products', { update: [{ id: modelId, attributes: attributePayload(plan.attributes) }] });
    const u = res.update[0];
    if (!u.ok) return { result: done(false, `No se pudieron actualizar los atributos de ${model.sku}: ${u.error}`), backups };
    backups.push({ kind: 'product', action: 'update', wooId: modelId, sku: model.sku, fields: ['attributes'], before: { attributes: pick(model, 'attributes') }, after: { attributes: pick(u.data, 'attributes') } });
    // Sus variaciones sin color (o sin talla) reciben el que les toca.
    const fixes = plan.parentFixes.filter((f) => f.needsUpdate);
    if (fixes.length) {
      const fr = await store.batch(`products/${modelId}/variations`, { update: fixes.map((f) => ({ id: f.variation.id, attributes: variationAttrs(f, plan) })) });
      fixes.forEach((f, i) => {
        const r = fr.update[i];
        if (r.ok) backups.push({ kind: 'variation', action: 'update', wooId: f.variation.id, parentId: modelId, sku: f.variation.sku, fields: ['attributes'], before: { attributes: pick(f.variation, 'attributes') }, after: { attributes: pick(r.data, 'attributes') } });
        else log(`${plan.style}: no se pudo poner color/talla a ${f.variation.sku}: ${r.error}`);
      });
    }
  }

  // 2. Las fuentes a la papelera (libera sus SKU) y se crean como variaciones del modelo.
  try {
    await trashSources(plan);
  } catch (error) {
    // Se regresa también lo que ya se había mandado a la papelera, y se borra el modelo recién creado.
    for (const e of plan.entries.filter((x) => x.trashed)) await restoreSource(e).catch(() => {});
    if (plan.mode === 'merge') {
      const removed = await store.request('delete', `products/${modelId}`, { force: true }, undefined, 1).then(() => true).catch(() => false);
      if (removed) backups.length = 0;
    }
    return { result: done(false, `No se pudo mandar a la papelera lo anterior: ${error.message}. No se movió nada.`), backups };
  }
  log(`${plan.style}: creando ${plan.entries.length} variación(es)…`);
  const res = await store.batch(`products/${modelId}/variations`, { create: plan.entries.map((e) => variationPayload(e, variationAttrs(e, plan))) });
  const failed = [];
  plan.entries.forEach((e, i) => {
    const r = res.create[i];
    if (r.ok) {
      e.newId = r.data.id;
      backups.push({ kind: 'variation', action: 'create', wooId: r.data.id, parentId: modelId, sku: e.sku, after: { date_modified: r.data.date_modified || null } });
    } else {
      failed.push({ e, error: r.error });
    }
  });
  // Lo que no se pudo crear regresa a como estaba.
  for (const { e } of failed) await restoreSource(e).catch((err) => log(`OJO: ${e.sku} quedó en la papelera sin SKU (${err.message}). Restáuralo desde WordPress y ponle de nuevo el SKU.`));
  // (Se respaldan después de sus productos: "Deshacer" primero saca de la papelera al producto y luego a sus variaciones.)
  const sourceRows = plan.entries.filter((x) => x.trashed).map((e) => (e.source === 'variation'
    ? { kind: 'variation', action: 'delete', wooId: e.variation.id, parentId: e.product.id, sku: e.sku, before: { versions: e.trashed } }
    : { kind: 'product', action: 'delete', wooId: e.product.id, sku: e.sku, before: { versions: e.trashed } }));

  // 3. Los productos por color que quedaron vacíos, a la papelera.
  for (const p of plan.trashProducts) {
    const stillThere = plan.entries.some((e) => e.source === 'variation' && e.product.id === p.id && !e.newId);
    if (stillThere) continue;
    try {
      const snap = await trash.snapshotProduct(p);
      await trash.trashProduct(snap);
      backups.push({ kind: 'product', action: 'delete', wooId: p.id, sku: p.sku, before: { versions: snap } });
    } catch (error) {
      log(`${plan.style}: no se pudo mandar a la papelera ${p.sku}: ${error.message}`);
    }
  }
  backups.push(...sourceRows);

  // Fecha final del modelo (crear variaciones la cambia): "Deshacer" la usa para saber si alguien lo tocó después.
  if (plan.mode === 'merge') {
    const [fresh] = await store.fetchProductsByIds([modelId]).catch(() => []);
    if (fresh) {
      backups[0].after.date_modified = fresh.date_modified;
      model = fresh;
    }
  }
  const moved = plan.entries.filter((e) => e.newId).length;
  const message = failed.length
    ? `Se movieron ${moved} de ${plan.entries.length} variación(es). Fallaron: ${failed.map((f) => `${f.e.sku} (${f.error})`).join('; ')}`
    : `${plan.mode === 'merge' ? 'Modelo creado' : `Pasaron a ${model.sku}`} con ${moved} variación(es) nueva(s)`;
  return { result: done(!failed.length, message, { url: model.permalink || null, adminUrl: adminUrl(modelId), moved, newId: plan.mode === 'merge' ? modelId : null }), backups };
}

/** Paso 2: aplica los estilos elegidos (`selected`) con su nombre (`names`). Guarda el respaldo en `pool`. */
async function applyMerge(review, { selected, names = {}, pool, runId, log = console.log, progress = () => {} }) {
  const plans = review.plans.filter((p) => !p.errors.length && selected.has(p.style));
  let done = 0;
  for (const plan of plans) {
    const name = plan.mode === 'merge' ? String(names[plan.style] || plan.modelName).trim() : plan.modelName;
    plan.chosenName = name;
    let backups = [];
    try {
      ({ result: plan.result, backups } = await applyGroup(plan, name, { log }));
    } catch (error) {
      plan.result = { ok: false, message: error.response?.data?.message || error.message };
    }
    for (const row of backups) {
      await saveRow(pool, runId, row).catch((e) => log(`No se pudo guardar el respaldo de ${row.sku}: ${e.message}`));
    }
    log(`${plan.result.ok ? '✔' : '✖'} ${plan.style}: ${plan.result.message}`);
    done += 1;
    progress(done, plans.length, 'Estilos corregidos');
    if (done < plans.length) await sleep(PAUSE_MS);
  }
  const ok = plans.filter((p) => p.result?.ok).length;
  return {
    summary: {
      'Estilos corregidos': ok,
      'Con error': plans.length - ok,
      'Variaciones movidas': plans.reduce((n, p) => n + (p.result?.moved || 0), 0),
    },
  };
}

// Formato de la tabla de revisión del panel (mismo que "Revisar cambios") y de la lista para elegir.
function publicMerge(review, { withResults = false } = {}) {
  const label = { merge: 'Modelo nuevo', 'into-parent': 'Pasa a su padre', rename: 'Cambia SKU' };
  const items = review.plans.map((p, n) => {
    const changes = [];
    if (p.mode === 'rename') {
      changes.push({ field: 'SKU', from: p.rename.from, to: p.rename.to });
      changes.push({ field: 'URL (no cambia)', from: null, to: p.url || '—' });
    } else {
      if (p.mode === 'merge') changes.push({ field: 'Producto Variable nuevo', from: null, to: `${p.chosenName || p.modelName} (SKU ${p.style})` });
      else changes.push({ field: `Variable ${p.parent?.sku}`, from: null, to: 'recibe los colores sueltos' });
      changes.push({ field: 'URL final', from: null, to: p.url || '—' });
      const colors = p.attributes?.find((a) => isAttr(a, 'color'))?.options || [];
      const tallas = p.attributes?.find((a) => isAttr(a, 'talla'))?.options || [];
      changes.push({ field: 'Colores', from: null, to: colors.join(', ') || '—' });
      changes.push({ field: 'Tallas', from: null, to: tallas.join(', ') || '—' });
      for (const s of p.sources) {
        const moved = p.entries.filter((e) => e.product.id === s.id).length;
        changes.push({ field: s.sku, from: `${s.name}${s.url ? ` (${s.url})` : ''}`, to: `a la papelera; ${moved} variación(es) pasan al modelo` });
      }
    }
    return {
      row: n + 1,
      kind: p.mode === 'merge' ? 'create' : 'update',
      type: label[p.mode] || '',
      sku: p.style,
      name: p.chosenName || p.modelName,
      attributes: p.mode === 'rename' ? '1 color' : `${p.sources.length} producto(s) · ${p.entries.length} variación(es)`,
      changes,
      conflicts: [],
      skipped: [],
      errors: p.errors,
      warnings: p.warnings,
    };
  });
  return {
    summary: review.summary,
    notes: [
      'Elige abajo qué estilos se corrigen y, en los modelos nuevos, revisa el nombre (de él sale la URL).',
      'Las URLs anteriores de los productos que van a la papelera dejan de funcionar. Al terminar haz "Traer de la tienda" para poner el Excel al día.',
    ],
    items,
    groups: review.plans.map((p) => ({ style: p.style, mode: p.mode, name: p.chosenName || p.modelName, url: p.url, urlBase: p.urlBase || null, ok: !p.errors.length, doubt: Boolean(p.doubt), warnings: p.warnings.length })),
    // Para que el panel calcule la URL al cambiar el nombre (WordPress agrega -2, -3… si ya existe).
    slugsTaken: [...(review.slugsTaken || [])],
    results: withResults
      ? review.plans.map((p, n) => (p.result ? { row: n + 1, sku: p.style, ok: p.result.ok, message: p.result.message, newId: p.result.newId || null, url: p.result.url, adminUrl: p.result.adminUrl } : null)).filter(Boolean)
      : undefined,
  };
}

module.exports = { reviewMerge, applyMerge, publicMerge, summarize, planGroup, modelName, learnSizes, learnColors, slugify, finalUrl };
