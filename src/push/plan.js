// Construye el "plan" del push: qué filas del Excel cambiaron respecto a la
// foto del último pull, qué productos nuevos hay, qué errores tienen y qué
// cambios chocan con ediciones hechas directo en la tienda.
const { catalogToRows, VARIATION_STATUS } = require('../excel/layout');
const store = require('../woo/store');
const {
  COL, ATTRIBUTE_COLUMNS, ATTR_KEYS, TYPE, ANY, DELETE_STATUS, EDITABLE_ON_UPDATE, VARIATION_STATUS_SLUG,
  isBlank, isDelete, splitList, splitCategories, canonical, same, applies, normalizeType, validateRow,
} = require('./fields');
const { isVariationAttribute, shouldVary, findGlobal, applyRule } = require('./attributeRules');

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
 * padre + valores usados por sus variaciones. Regla de la tienda: siempre
 * globales y solo Color y Talla para variaciones (ver attributeRules.js). Un
 * atributo local que se usa para variaciones se deja local: pasarlo a global
 * rompería las variaciones existentes.
 */
function desiredAttributes(parentRow, variationRows, storeProduct, globalAttrs) {
  const current = storeProduct?.attributes || [];
  const findCurrent = (names) => current.find((a) => names.includes(norm(a.name)));

  const out = [];
  const warnings = [];
  // Color es la primera columna: al llegar a Talla ya se sabe si el producto tiene Color.
  const withColor = () => out.some((a) => isVariationAttribute(a.name) && norm(a.name) === 'color');
  const add = (names, label, parentValue, variationValues) => {
    const usedByVariations = variationValues.filter((v) => !isBlank(v) && norm(v) !== ANY);
    const options = uniqueCaseInsensitive([...splitList(parentValue, '|'), ...usedByVariations]);
    if (!options.length) return;
    const cur = findCurrent(names);
    const glob = findGlobal(globalAttrs, names);
    const forVariations = shouldVary(names, options, withColor());
    // Otro atributo solo se deja para variaciones si las distingue (valores distintos entre ellas).
    const distinguishes = uniqueCaseInsensitive(usedByVariations).length > 1;
    const variation = forVariations || distinguishes;
    if (!forVariations && distinguishes) warnings.push(`${cur?.name || label} se usa para variaciones porque sus variaciones tienen valores distintos; solo Color y Talla deberían.`);
    const keepLocal = cur && !cur.id && variation;
    if (keepLocal && glob) warnings.push(`${cur.name} es local y se usa para variaciones; no se pasa a global para no romper las variaciones.`);
    const useGlobal = glob && !keepLocal;
    out.push({
      id: useGlobal ? glob.id : cur?.id || 0,
      name: useGlobal ? glob.name : cur?.name || label,
      options,
      visible: cur?.visible ?? true,
      variation,
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
  return { attributes: out, warnings };
}

const attrSignature = (list) => (list || [])
  .map((a) => `${a.id || 0}:${norm(a.name)}:${a.variation ? 1 : 0}:${a.options.map(norm).sort().join('|')}`)
  .sort()
  .join(';');

const attrSummary = (list) => (list || []).map((a) => `${a.name}: ${a.options.join(' | ')}`).join('; ') || '(sin atributos)';

/**
 * @param {object} excel   resultado de readWorkbook
 * @param {object} options { allowedFields: Set|null (null = todos), canCreate, canDelete, log, onProgress }
 */
async function buildPlan(excel, { allowedFields = null, canCreate = true, canDelete = false, log = () => {} } = {}) {
  const baseById = new Map(excel.baseRows.map((b) => [String(b.id), b]));
  const items = [];
  const notes = [];
  let ignoredDeletes = 0;

  // Estado "Eliminar": el producto/variación se manda a la papelera; los demás cambios de la fila se ignoran.
  const markDelete = (item, base) => {
    item.type = base.type;
    item.kind = 'delete';
    item.changes.push({ key: 'status', header: COL.status.header, from: base.status ?? null, to: DELETE_STATUS });
    if (!canDelete) item.errors.push('Tu perfil no tiene permiso para eliminar. Pídeselo al administrador.');
    item.warnings.push(base.type === TYPE.variable
      ? 'Se manda a la papelera de WordPress junto con todas sus variaciones.'
      : 'Se manda a la papelera de WordPress.');
  };

  // Simple -> Variación (variante que quedó suelta): se crea la variación con los
  // datos de la fila y el simple se manda a la papelera para liberar su SKU.
  const markConversion = (item, row, base) => {
    item.type = TYPE.variation;
    item.kind = 'create';
    item.id = null;
    item.base = null;
    item.replaces = { id: Number(base.id), sku: base.sku ?? null, name: base.name ?? null };
    const status = norm(row.status);
    item.data = { ...row, status: VARIATION_STATUS_SLUG[status] ? row.status : (!status || status === 'publicado' ? VARIATION_STATUS.publish : VARIATION_STATUS.private) };
    if (!canCreate) item.errors.push('Tu perfil no puede crear productos.');
    if (!canDelete) item.errors.push('Para convertir un simple en variación se necesita el permiso de eliminar (el simple se manda a la papelera). Pídeselo al administrador.');
    // La descripción larga del simple no pasa: la variación muestra la del padre.
    for (const key of EDITABLE_ON_UPDATE) {
      if (key !== 'description' && applies(key, TYPE.variation) && !isBlank(item.data[key])) {
        item.changes.push({ key, header: COL[key].header, from: null, to: item.data[key] });
      }
    }
    item.warnings.push(`Reemplaza al producto simple ID ${base.id}${base.name ? ` ("${base.name}")` : ''}: se crea esta variación con su SKU, precio, inventario y fotos, y el simple se manda a la papelera. Nombre, categorías y descripciones los toma del padre.`);
  };

  // Un ID repetido casi siempre es una fila copiada para crear otra: si se
  // aceptara, la copia sobrescribiría al producto original.
  const idCount = new Map();
  for (const row of excel.rows) if (!isBlank(row.id)) idCount.set(String(row.id).trim(), (idCount.get(String(row.id).trim()) || 0) + 1);

  // --- 1. Clasificar filas: cambios en existentes y altas nuevas ---
  for (const row of excel.rows) {
    const id = isBlank(row.id) ? null : String(row.id).trim();
    const base = id ? baseById.get(id) : null;
    // Fila nueva marcada "Eliminar": no existe en la tienda, no hay nada que borrar.
    if (!id && isDelete(row.status)) {
      ignoredDeletes += 1;
      continue;
    }
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

    const typed = normalizeType(row.type);
    if (base && isDelete(row.status)) {
      if (isDelete(base.status)) continue; // ya se eliminó en un push anterior
      markDelete(item, base);
    } else if (base && base.type === TYPE.simple && typed === TYPE.variation) {
      markConversion(item, row, base);
    } else if (base) {
      item.type = base.type === TYPE.simple && typed === TYPE.variable ? TYPE.variable : base.type;
      if (typed && typed !== item.type) {
        item.errors.push(`No se puede cambiar el tipo de "${base.type}" a "${typed}". Solo se permite Simple → Variable o Simple → Variación.`);
      }
      if (item.type !== base.type) {
        item.typeChange = true;
        item.changes.push({ key: 'type', header: COL.type.header, from: base.type, to: item.type });
        item.warnings.push('Pasa a producto Variable: el precio y el inventario van en cada variación (agrégalas con este SKU como "SKU padre").');
      }
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

    if (item.type && item.kind !== 'delete') item.errors.push(...validateRow(item.data, item.type));
    // Una variación sin precio no se puede comprar y WooCommerce no la muestra.
    if (item.type === TYPE.variation && isBlank(row.regularPrice)) {
      const clearsPrice = item.changes.some((c) => c.key === 'regularPrice');
      if (item.kind === 'create' || clearsPrice) item.errors.push('La variación no tiene Precio normal. Sin precio no aparece en la tienda ni se puede comprar.');
      else if (item.changes.length) item.warnings.push('Esta variación no tiene Precio normal en la tienda: no aparece ni se puede comprar. Agrégale precio.');
    }
    items.push(item);
  }

  // --- 2. Relación padre/variación ---
  // Tipo de cada fila: el de la tienda, salvo los cambios permitidos desde Simple.
  const typeOfRow = (row) => {
    const base = isBlank(row.id) ? null : baseById.get(String(row.id).trim());
    const typed = normalizeType(row.type);
    if (base?.type === TYPE.simple && (typed === TYPE.variable || typed === TYPE.variation)) return typed;
    return base ? base.type : typed;
  };
  const allRows = excel.rows.map((row) => ({ row, type: typeOfRow(row) }));
  const parentsBySku = new Map();
  for (const { row, type } of allRows) {
    if (type === TYPE.variable && skuKey(row.sku)) parentsBySku.set(skuKey(row.sku), row);
  }
  const variationsOf = (parentRow) => allRows
    .filter(({ row, type }) => type === TYPE.variation && !isDelete(row.status) && skuKey(row.parentSku) && skuKey(row.parentSku) === skuKey(parentRow.sku))
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

  // Variaciones de un producto que se elimina: se van a la papelera con él.
  const deletedParents = new Set(items.filter((i) => i.kind === 'delete' && i.type === TYPE.variable && !i.errors.length).map((i) => i.row));
  for (const item of items.filter((i) => i.type === TYPE.variation && deletedParents.has(i.parentRow))) {
    if (item.kind === 'delete') {
      item.changes = [];
      item.cascadeOf = items.find((i) => i.row === item.parentRow); // el padre que se elimina
      item.warnings.push('Se elimina junto con su producto padre.');
    } else {
      item.errors.push('Su producto padre se va a eliminar; no se puede crear ni modificar esta variación.');
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
    const existing = item.kind === 'update' || item.kind === 'delete';
    if (item.type === TYPE.variation && item.parentId) {
      productIds.add(item.parentId);
      if (existing) {
        if (!variationIdsByParent.has(item.parentId)) variationIdsByParent.set(item.parentId, []);
        variationIdsByParent.get(item.parentId).push(item.id);
      }
    } else if (existing) {
      productIds.add(item.id);
    }
  }
  const storeProducts = new Map((await store.fetchProductsByIds([...productIds])).map((p) => [p.id, p]));
  for (const [parentId, ids] of variationIdsByParent) {
    const parent = storeProducts.get(parentId);
    if (parent) parent.variations_data = await store.fetchVariationsByIds(parentId, ids);
  }
  const storeRows = new Map(catalogToRows({ products: [...storeProducts.values()], categories: taxonomies.categories }).map((r) => [r.id, r]));

  for (const item of items.filter((i) => (i.kind === 'update' || i.kind === 'delete') && !i.errors.length)) {
    const current = storeRows.get(item.id);
    if (!current) {
      item.errors.push(isDelete(item.base?.status)
        ? 'Se eliminó en un push anterior (está en la papelera). Restáuralo con "Deshacer" o desde WordPress.'
        : 'Este producto ya no existe en la tienda (¿lo borraron desde WordPress?).');
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

  // Simples que pasan a ser variación: deben seguir en la tienda y seguir siendo simples.
  const conversions = items.filter((i) => i.replaces && i.kind === 'create' && !i.errors.length);
  if (conversions.length) {
    const found = new Map((await store.fetchProductsByIds(conversions.map((i) => i.replaces.id))).map((p) => [p.id, p]));
    for (const item of conversions) {
      const product = found.get(item.replaces.id);
      if (!product) item.errors.push(`El producto simple ID ${item.replaces.id} ya no existe en la tienda.`);
      else if (product.type !== 'simple') item.errors.push(`El producto ID ${item.replaces.id} ya no es simple en la tienda. Haz "Traer de la tienda".`);
      else item.replaces.product = product;
    }
  }
  // Variaciones nuevas con un SKU que ya usa un producto (la variante suelta como simple).
  const newVariations = variationCreates.filter((i) => i.kind === 'create' && !i.errors.length);
  if (newVariations.length) {
    const owners = (await store.fetchProductsBySkus(newVariations.map((i) => String(i.data.sku).trim())))
      .filter((p) => p.status !== 'trash'); // en la papelera ya no reserva el SKU
    const ownerBySku = new Map(owners.map((p) => [skuKey(p.sku), p]));
    for (const item of newVariations) {
      const owner = ownerBySku.get(skuKey(item.data.sku));
      if (!owner || owner.id === item.replaces?.id) continue;
      item.errors.push(owner.type === 'simple'
        ? `El SKU "${item.data.sku}" ya es del producto simple ID ${owner.id} ("${owner.name}"). Para convertirlo en variación, en la fila de ESE producto cambia el Tipo a "Variación" y escribe el SKU padre (y borra esta fila).`
        : `El SKU "${item.data.sku}" ya lo usa otro producto de la tienda (ID ${owner.id}).`);
    }
  }

  // --- 6. Atributos de productos variables (opciones nuevas, valores cambiados) ---
  const parentsToSync = new Map(); // fila del padre -> item
  // Un Variable que se toca por otra razón también se corrige si no cumple la regla de atributos.
  const breaksRule = (item) => item.type === TYPE.variable && item.id && storeProducts.has(item.id)
    && applyRule(storeProducts.get(item.id).attributes, taxonomies.attributes, (a) => a.variation).changes.length > 0;
  for (const item of items.filter((i) => !i.errors.length)) {
    const touchesAttrs = item.kind === 'create' || item.typeChange || item.changes.some((c) => ATTR_KEYS.has(c.key) || c.key === 'otherAttributes') || breaksRule(item);
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
    const { attributes: desired, warnings } = desiredAttributes(parentItem.data, variationsOf(parentItem.data), storeProduct, taxonomies.attributes);
    parentItem.warnings.push(...warnings);
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

  // Variación nueva cuyo padre (nuevo, o simple que pasa a Variable) no se puede subir: tampoco se sube.
  for (const item of items.filter((i) => i.type === TYPE.variation && i.kind === 'create' && !i.errors.length)) {
    const parentItem = items.find((i) => i.row === item.parentRow);
    if (parentItem?.errors.length && (!item.parentId || parentItem.typeChange)) {
      item.errors.push('No se puede crear porque su producto padre tiene errores (ver la fila del padre).');
    }
  }
  if (ignoredDeletes) notes.push(`${ignoredDeletes} fila(s) sin "ID tienda" con Estado "Eliminar" se ignoraron: no existen en la tienda.`);

  // --- 8. Resumen ---
  const live = items.filter((i) => !i.errors.length && i.changes.length);
  const summary = {
    'Productos/variaciones nuevos': live.filter((i) => i.kind === 'create' && !i.replaces).length,
    'Productos/variaciones con cambios': live.filter((i) => i.kind === 'update').length,
    'Simples que pasan a variación': live.filter((i) => i.replaces).length,
    'A eliminar (papelera)': live.filter((i) => i.kind === 'delete').length,
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
        replaces: i.replaces ? { id: i.replaces.id, sku: i.replaces.sku, name: i.replaces.name } : null,
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
