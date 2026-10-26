// Construye el "plan" del push: qué filas del Excel cambiaron respecto a la
// foto del último pull, qué productos nuevos hay, qué errores tienen y qué
// cambios chocan con ediciones hechas directo en la tienda.
const { catalogToRows } = require('../excel/layout');
const store = require('../woo/store');
const {
  COL, ATTRIBUTE_COLUMNS, ATTR_KEYS, TYPE, ANY, EDITABLE_ON_UPDATE,
  isBlank, splitList, splitCategories, canonical, same, applies, normalizeType, validateRow,
} = require('./fields');

const norm = (s) => String(s || '').trim().toLowerCase();
const skuKey = (s) => (isBlank(s) ? null : String(s).trim().toUpperCase());
const show = (key, v) => (isBlank(v) ? '(vacío)' : canonical(key, v));

function uniqueCaseInsensitive(values) {
  const seen = new Map();
  for (const v of values) if (!isBlank(v) && !seen.has(norm(v))) seen.set(norm(v), String(v).trim());
  return [...seen.values()];
}

// "Diseño: Liso | Rayas; Estampado: Flores" -> Map(nombre normalizado -> { label, value })
function parseOthers(text) {
  const out = new Map();
  for (const part of splitList(text, ';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const label = part.slice(0, idx).trim();
    out.set(norm(label), { label, value: part.slice(idx + 1).trim() });
  }
  return out;
}

/**
 * Atributos que debe tener un producto variable según el Excel: opciones del
 * padre + valores usados por sus variaciones. Conserva el tipo (global/local) y
 * la configuración que el atributo ya tenga en la tienda, para no romper las
 * variaciones existentes.
 */
function desiredAttributes(parentRow, variationRows, storeProduct, globalAttrs) {
  const current = storeProduct?.attributes || [];
  const findCurrent = (names) => current.find((a) => names.includes(norm(a.name)));
  const findGlobal = (names) => globalAttrs.find((g) => names.includes(norm(g.name)) || names.includes(norm(g.slug.replace(/^pa_/, ''))));

  const out = [];
  const add = (names, label, parentValue, variationValues) => {
    const usedByVariations = variationValues.filter((v) => !isBlank(v) && norm(v) !== ANY);
    const options = uniqueCaseInsensitive([...splitList(parentValue, '|'), ...usedByVariations]);
    if (!options.length) return;
    const cur = findCurrent(names);
    const glob = cur ? null : findGlobal(names);
    out.push({
      id: cur ? cur.id : glob?.id || 0,
      name: cur?.name || glob?.name || label,
      options,
      visible: cur?.visible ?? true,
      variation: Boolean(cur?.variation) || usedByVariations.length > 0,
      position: cur?.position ?? out.length,
    });
  };

  for (const col of ATTRIBUTE_COLUMNS) {
    add(col.names, col.header, parentRow[col.key], variationRows.map((v) => v[col.key]));
  }
  const parentOthers = parseOthers(parentRow.otherAttributes);
  const variationOthers = variationRows.map((v) => parseOthers(v.otherAttributes));
  const otherNames = new Map([...parentOthers, ...variationOthers.flatMap((m) => [...m])].map(([k, v]) => [k, v.label]));
  for (const [key, label] of otherNames) {
    add([key], label, parentOthers.get(key)?.value, variationOthers.map((m) => m.get(key)?.value));
  }
  return out;
}

const attrSignature = (list) => (list || [])
  .map((a) => `${a.id || 0}:${norm(a.name)}:${a.variation ? 1 : 0}:${a.options.map(norm).sort().join('|')}`)
  .sort()
  .join(';');

const attrSummary = (list) => (list || []).map((a) => `${a.name}: ${a.options.join(' | ')}`).join('; ') || '(sin atributos)';

/**
 * @param {object} excel   resultado de readWorkbook
 * @param {object} options { allowedFields: Set|null (null = todos), canCreate, log, onProgress }
 */
async function buildPlan(excel, { allowedFields = null, canCreate = true, log = () => {} } = {}) {
  const baseById = new Map(excel.baseRows.map((b) => [String(b.id), b]));
  const items = [];
  const notes = [];

  // Un ID repetido casi siempre es una fila copiada para crear otra: si se
  // aceptara, la copia sobrescribiría al producto original.
  const idCount = new Map();
  for (const row of excel.rows) if (!isBlank(row.id)) idCount.set(String(row.id).trim(), (idCount.get(String(row.id).trim()) || 0) + 1);

  // --- 1. Clasificar filas: cambios en existentes y altas nuevas ---
  for (const row of excel.rows) {
    const id = isBlank(row.id) ? null : String(row.id).trim();
    const base = id ? baseById.get(id) : null;
    const item = {
      row: row._row, id: id ? Number(id) : null, data: row, base,
      type: null, kind: id ? 'update' : 'create', changes: [], conflicts: [], skipped: [], errors: [], warnings: [], synced: [],
    };

    if (id && idCount.get(id) > 1) {
      item.type = base?.type || normalizeType(row.type);
      item.errors.push(`El ID ${id} está repetido en el Excel. Si copiaste una fila para crear un producto o variación nueva, borra el "ID tienda" de la copia.`);
      items.push(item);
      continue;
    }

    if (id && !base) {
      item.type = normalizeType(row.type);
      item.errors.push('Este ID no viene del último "Traer de la tienda". No escribas ni copies IDs: déjalo vacío para crear un producto nuevo.');
      items.push(item);
      continue;
    }

    if (base) {
      item.type = base.type;
      const typed = normalizeType(row.type);
      if (typed && typed !== base.type) item.errors.push(`No se puede cambiar el tipo de "${base.type}" a "${typed}".`);
      if (base.type === TYPE.variation && !same('parentSku', row.parentSku, base.parentSku)) {
        item.errors.push('No se puede mover una variación a otro padre. Crea una variación nueva en el otro producto.');
      }
      for (const key of EDITABLE_ON_UPDATE) {
        if (!applies(key, item.type) || same(key, row[key], base[key])) continue;
        item.changes.push({ key, header: COL[key].header, from: base[key] ?? null, to: row[key] ?? null });
      }
      if (!item.changes.length && !item.errors.length) continue; // fila sin cambios
    } else {
      item.type = normalizeType(row.type);
      if (!item.type) item.errors.push(`Falta el Tipo (Simple, Variable o Variación)${isBlank(row.type) ? '' : `: "${row.type}" no es válido`}.`);
      if (!canCreate) item.errors.push('Tu perfil no puede crear productos.');
      if (item.type && item.type !== TYPE.variation && isBlank(row.name)) item.errors.push('Falta el Nombre.');
      for (const key of EDITABLE_ON_UPDATE) {
        if (item.type && applies(key, item.type) && !isBlank(row[key])) {
          item.changes.push({ key, header: COL[key].header, from: null, to: row[key] });
        }
      }
    }

    if (item.type) item.errors.push(...validateRow(row, item.type));
    items.push(item);
  }

  // --- 2. Relación padre/variación ---
  const allRows = excel.rows.map((row) => ({ row, type: row.id ? baseById.get(String(row.id))?.type : normalizeType(row.type) }));
  const parentsBySku = new Map();
  for (const { row, type } of allRows) {
    if (type === TYPE.variable && skuKey(row.sku)) parentsBySku.set(skuKey(row.sku), row);
  }
  const variationsOf = (parentRow) => allRows
    .filter(({ row, type }) => type === TYPE.variation && skuKey(row.parentSku) && skuKey(row.parentSku) === skuKey(parentRow.sku))
    .map(({ row }) => row);

  for (const item of items.filter((i) => i.type === TYPE.variation)) {
    const parentSku = item.base ? item.base.parentSku : item.data.parentSku;
    const parentRow = parentsBySku.get(skuKey(parentSku))
      || excel.rows.find((r) => baseById.get(String(r.id))?.type === TYPE.variable && skuKey(baseById.get(String(r.id)).sku) === skuKey(parentSku));
    if (!parentRow) {
      item.errors.push(isBlank(parentSku)
        ? 'Falta el "SKU padre" (el SKU del producto Variable al que pertenece).'
        : `No hay ningún producto Variable con SKU "${parentSku}" en el Excel.`);
      continue;
    }
    item.parentRow = parentRow._row;
    item.parentId = isBlank(parentRow.id) ? null : Number(parentRow.id);
    if (item.kind === 'create' && !ATTRIBUTE_COLUMNS.some((c) => !isBlank(item.data[c.key])) && isBlank(item.data.otherAttributes)) {
      item.errors.push('La variación nueva necesita al menos un valor de atributo (ej. Talla o Color).');
    }
  }

  // --- 3. SKUs repetidos en el Excel ---
  const skuCount = new Map();
  for (const { row } of allRows) if (skuKey(row.sku)) skuCount.set(skuKey(row.sku), (skuCount.get(skuKey(row.sku)) || 0) + 1);
  for (const item of items) {
    const touchesSku = item.kind === 'create' || item.changes.some((c) => c.key === 'sku');
    if (touchesSku && skuCount.get(skuKey(item.data.sku)) > 1) item.errors.push(`El SKU "${item.data.sku}" está repetido en el Excel.`);
  }

  // --- 4. Permisos por campo (en altas, crear exige permiso aparte) ---
  if (allowedFields) {
    for (const item of items.filter((i) => i.kind === 'update')) {
      item.skipped.push(...item.changes.filter((c) => !allowedFields.has(c.key)).map((c) => ({ ...c, reason: 'Tu perfil no puede cambiar este campo' })));
      item.changes = item.changes.filter((c) => allowedFields.has(c.key));
    }
  }

  // --- 5. Comparar contra la tienda (solo productos involucrados) ---
  log('Consultando en la tienda los productos con cambios...');
  const taxonomies = await store.fetchTaxonomies();
  const productIds = new Set();
  const variationIdsByParent = new Map();
  for (const item of items) {
    if (item.errors.length) continue;
    if (item.type === TYPE.variation && item.parentId) {
      productIds.add(item.parentId);
      if (item.kind === 'update') {
        if (!variationIdsByParent.has(item.parentId)) variationIdsByParent.set(item.parentId, []);
        variationIdsByParent.get(item.parentId).push(item.id);
      }
    } else if (item.kind === 'update') {
      productIds.add(item.id);
    }
  }
  const storeProducts = new Map((await store.fetchProductsByIds([...productIds])).map((p) => [p.id, p]));
  for (const [parentId, ids] of variationIdsByParent) {
    const parent = storeProducts.get(parentId);
    if (parent) parent.variations_data = await store.fetchVariationsByIds(parentId, ids);
  }
  const storeRows = new Map(catalogToRows({ products: [...storeProducts.values()], categories: taxonomies.categories }).map((r) => [r.id, r]));

  for (const item of items.filter((i) => i.kind === 'update' && !i.errors.length)) {
    const current = storeRows.get(item.id);
    if (!current) {
      item.errors.push('Este producto ya no existe en la tienda (¿lo borraron desde WordPress?).');
      continue;
    }
    const pending = [];
    for (const change of item.changes) {
      if (same(change.key, current[change.key], change.to)) {
        item.warnings.push(`${change.header}: la tienda ya tenía este valor.`);
        item.synced.push(change.key);
      } else if (!same(change.key, current[change.key], item.base[change.key])) {
        item.conflicts.push({ ...change, store: current[change.key] ?? null });
      } else {
        pending.push(change);
      }
    }
    item.changes = pending;
  }

  // --- 5b. Altas cuyo SKU ya existe en la tienda (ej. un push anterior que no
  // alcanzó a escribir el ID en el Excel): se vinculan a la fila, no se duplican ---
  const linkable = (i) => i.kind === 'create' && !i.errors.length && skuKey(i.data.sku);
  const linkTo = (item, product, storeRow) => {
    item.kind = 'link';
    item.id = product.id;
    item.changes = [];
    item.linkBase = storeRow || null;
    item.warnings.push(`Ya existe en la tienda con ID ${product.id} (seguramente de una subida anterior). Se vincula a esta fila; no se crea de nuevo.`);
  };
  const productCreates = items.filter((i) => linkable(i) && i.type !== TYPE.variation);
  if (productCreates.length) {
    const found = await store.fetchProductsBySkus(productCreates.map((i) => String(i.data.sku).trim()));
    // Si un SKU aparece activo y en la papelera, gana el activo.
    const bySku = new Map(found.sort((a, b) => (b.status === 'trash') - (a.status === 'trash')).map((p) => [skuKey(p.sku), p]));
    for (const item of productCreates) {
      const product = bySku.get(skuKey(item.data.sku));
      if (!product) continue;
      if (product.status === 'trash') {
        item.errors.push(`El SKU "${item.data.sku}" pertenece a un producto que está en la PAPELERA de WordPress (ID ${product.id}). Restáuralo desde WordPress, o elimínalo definitivamente de la papelera para poder crearlo de nuevo.`);
        continue;
      }
      if ((product.type === 'variable') !== (item.type === TYPE.variable)) {
        item.errors.push(`El SKU "${item.data.sku}" ya lo usa otro producto de la tienda (ID ${product.id}).`);
        continue;
      }
      storeProducts.set(product.id, product);
      const storeRow = catalogToRows({ products: [{ ...product, variations_data: [] }], categories: taxonomies.categories }).find((r) => r.id === product.id);
      linkTo(item, product, storeRow);
    }
  }
  // Variaciones nuevas: su padre puede ser existente o uno que se acaba de vincular.
  const parentIdOfRow = new Map(items.filter((i) => i.type === TYPE.variable && i.id).map((i) => [i.row, i.id]));
  const variationCreates = items.filter((i) => linkable(i) && i.type === TYPE.variation);
  for (const item of variationCreates) if (!item.parentId && parentIdOfRow.has(item.parentRow)) item.parentId = parentIdOfRow.get(item.parentRow);
  const parentsToCheck = [...new Set(variationCreates.filter((i) => i.parentId).map((i) => i.parentId))];
  for (const parentId of parentsToCheck) {
    const variations = await store.fetchAllVariations(parentId);
    const bySku = new Map(variations.filter((v) => v.sku).map((v) => [skuKey(v.sku), v]));
    const parent = storeProducts.get(parentId) || (await store.fetchProductsByIds([parentId]))[0];
    if (!parent) continue;
    storeProducts.set(parentId, { ...parent, variations_data: [...(parent.variations_data || []), ...variations.filter((v) => !(parent.variations_data || []).some((x) => x.id === v.id))] });
    const rows = catalogToRows({ products: [{ ...parent, variations_data: variations }], categories: taxonomies.categories });
    for (const item of variationCreates.filter((i) => i.parentId === parentId)) {
      const variation = bySku.get(skuKey(item.data.sku));
      if (variation) linkTo(item, variation, rows.find((r) => r.id === variation.id));
    }
  }

  // --- 6. Atributos de productos variables (opciones nuevas, valores cambiados) ---
  const parentsToSync = new Map(); // fila del padre -> item
  for (const item of items.filter((i) => !i.errors.length)) {
    const touchesAttrs = item.kind === 'create' || item.changes.some((c) => ATTR_KEYS.has(c.key) || c.key === 'otherAttributes');
    if (!touchesAttrs) continue;
    if (item.type === TYPE.variable) parentsToSync.set(item.row, item);
    if (item.type === TYPE.variation && item.parentRow) {
      if (!parentsToSync.has(item.parentRow)) {
        const parentRow = excel.rows.find((r) => r._row === item.parentRow);
        let parentItem = items.find((i) => i.row === item.parentRow);
        if (!parentItem) {
          parentItem = { row: parentRow._row, id: Number(parentRow.id), data: parentRow, base: baseById.get(String(parentRow.id)), type: TYPE.variable, kind: 'update', changes: [], conflicts: [], skipped: [], errors: [], warnings: [], synced: [] };
          items.push(parentItem);
        }
        parentsToSync.set(item.parentRow, parentItem);
      }
    }
  }
  for (const parentItem of parentsToSync.values()) {
    if (parentItem.errors.length) continue;
    const storeProduct = parentItem.id ? storeProducts.get(parentItem.id) : null;
    const desired = desiredAttributes(parentItem.data, variationsOf(parentItem.data), storeProduct, taxonomies.attributes);
    if (attrSignature(desired) !== attrSignature(storeProduct?.attributes)) {
      parentItem.attributes = desired;
      parentItem.changes = parentItem.changes.filter((c) => !ATTR_KEYS.has(c.key) && c.key !== 'otherAttributes');
      parentItem.changes.push({ key: 'attributes', header: 'Atributos', from: storeProduct ? attrSummary(storeProduct.attributes) : null, to: attrSummary(desired) });
    } else {
      parentItem.changes = parentItem.changes.filter((c) => !ATTR_KEYS.has(c.key) && c.key !== 'otherAttributes');
    }
  }

  // --- 7. Categorías / etiquetas / marcas que no existen y se crearán ---
  const categoryPaths = new Map(taxonomies.categories.map((c) => [c.id, c]));
  const pathOf = (cat) => {
    const parts = [];
    for (let c = cat; c; c = categoryPaths.get(c.parent)) parts.unshift(c.name);
    return parts.join(' > ');
  };
  const existingCategories = new Set(taxonomies.categories.map((c) => norm(pathOf(c))));
  const existingTags = new Set(taxonomies.tags.map((t) => norm(t.name)));
  const existingBrands = new Set((taxonomies.brands || []).map((b) => norm(b.name)));
  const newTerms = { categories: new Set(), tags: new Set(), brands: new Set() };
  for (const item of items.filter((i) => !i.errors.length)) {
    for (const change of item.changes) {
      if (change.key === 'categories') splitCategories(change.to).filter((p) => !existingCategories.has(norm(p))).forEach((p) => newTerms.categories.add(p));
      if (change.key === 'tags') splitList(change.to, ',').filter((t) => !existingTags.has(norm(t))).forEach((t) => newTerms.tags.add(t));
      if (change.key === 'brand') {
        if (!taxonomies.brands) item.errors.push('Esta tienda no tiene marcas de WooCommerce; deja la columna Marca como estaba.');
        else splitList(change.to, ',').filter((b) => !existingBrands.has(norm(b))).forEach((b) => newTerms.brands.add(b));
      }
    }
  }

  // Variación nueva cuyo padre (nuevo) no se puede subir: tampoco se sube.
  for (const item of items.filter((i) => i.type === TYPE.variation && i.kind === 'create' && !i.errors.length && !i.parentId)) {
    const parentItem = items.find((i) => i.row === item.parentRow);
    if (parentItem?.errors.length) item.errors.push('No se puede crear porque su producto padre tiene errores (ver la fila del padre).');
  }

  // --- 8. Resumen ---
  const live = items.filter((i) => !i.errors.length && i.changes.length);
  const summary = {
    'Productos/variaciones nuevos': live.filter((i) => i.kind === 'create').length,
    'Productos/variaciones con cambios': live.filter((i) => i.kind !== 'create').length,
    'Ya existían en la tienda (se vinculan)': items.filter((i) => i.kind === 'link' && !i.errors.length).length,
    'Campos a cambiar': live.filter((i) => i.kind === 'update').reduce((n, i) => n + i.changes.length, 0),
    'Filas con errores (no se suben)': items.filter((i) => i.errors.length).length,
    'Conflictos con la tienda (no se suben)': items.reduce((n, i) => n + i.conflicts.length, 0),
    'Sin permiso (no se suben)': items.reduce((n, i) => n + i.skipped.length, 0),
    'Categorías nuevas': newTerms.categories.size,
    'Etiquetas nuevas': newTerms.tags.size,
  };
  const deletedRows = excel.baseRows.filter((b) => !excel.rows.some((r) => String(r.id) === String(b.id))).length;
  if (deletedRows) notes.push(`${deletedRows} fila(s) se borraron del Excel. Borrar una fila no borra el producto de la tienda; para ocultarlo cambia su Estado.`);

  return {
    items: items.sort((a, b) => a.row - b.row),
    summary,
    notes,
    newTerms: { categories: [...newTerms.categories], tags: [...newTerms.tags], brands: [...newTerms.brands] },
    taxonomies,
    storeProducts,
  };
}

// Versión para mostrar en el panel (sin datos internos).
function publicPlan(plan) {
  return {
    summary: plan.summary,
    notes: plan.notes,
    newTerms: plan.newTerms,
    items: plan.items
      .filter((i) => i.changes.length || i.errors.length || i.conflicts.length || i.skipped.length || i.kind === 'link')
      .map((i) => ({
        row: i.row,
        kind: i.kind,
        type: i.type,
        id: i.id,
        sku: i.data.sku ?? null,
        name: i.data.name ?? null,
        attributes: ATTRIBUTE_COLUMNS.map((c) => i.data[c.key]).filter((v) => !isBlank(v)).join(' · ') || null,
        changes: i.changes.map((c) => ({ field: c.header, from: c.from === null ? null : show(c.key, c.from), to: show(c.key, c.to) })),
        conflicts: i.conflicts.map((c) => ({ field: c.header, base: show(c.key, c.from), store: show(c.key, c.store), excel: show(c.key, c.to) })),
        skipped: i.skipped.map((c) => ({ field: c.header, reason: c.reason })),
        errors: i.errors,
        warnings: i.warnings,
      })),
  };
}

module.exports = { buildPlan, publicPlan, desiredAttributes };
