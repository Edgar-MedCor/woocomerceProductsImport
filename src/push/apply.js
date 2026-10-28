// Ejecuta un plan del push en la tienda: crea términos que falten, luego
// productos (simples y variables), variaciones por lotes y al final lo que se
// manda a la papelera.
const store = require('../woo/store');
const trash = require('./trash');
const {
  ATTRIBUTE_COLUMNS, META_COLUMNS, TYPE, ANY,
  STOCK_STATUS_SLUG, PRODUCT_STATUS_SLUG, VARIATION_STATUS_SLUG,
  isBlank, parseNumber, splitList, splitCategories,
} = require('./fields');

const norm = (s) => String(s || '').trim().toLowerCase();
const str = (v) => (isBlank(v) ? '' : String(parseNumber(v)));

// ---------- términos (categorías, etiquetas, marcas) ----------
async function ensureTerms(plan, log) {
  const { categories, tags } = plan.taxonomies;
  const brands = plan.taxonomies.brands || [];
  const created = [];

  const byParentAndName = new Map(categories.map((c) => [`${c.parent}|${norm(c.name)}`, c]));
  const categoryIdByPath = new Map();
  const resolveCategory = async (path) => {
    let parent = 0;
    for (const name of path.split(' > ')) {
      let cat = byParentAndName.get(`${parent}|${norm(name)}`);
      if (!cat) {
        cat = await store.createTerm('products/categories', { name, parent });
        byParentAndName.set(`${parent}|${norm(name)}`, cat);
        created.push(`Categoría: ${path}`);
        log(`Categoría creada: ${name}${parent ? ' (subcategoría)' : ''}`);
      }
      parent = cat.id;
    }
    categoryIdByPath.set(norm(path), parent);
    return parent;
  };

  const tagByName = new Map(tags.map((t) => [norm(t.name), t]));
  const brandByName = new Map(brands.map((b) => [norm(b.name), b]));
  const resolveSimple = async (map, endpoint, label, name) => {
    let term = map.get(norm(name));
    if (!term) {
      term = await store.createTerm(endpoint, { name });
      map.set(norm(name), term);
      created.push(`${label}: ${name}`);
      log(`${label} creada: ${name}`);
    }
    return term.id;
  };

  return {
    created,
    categoryIds: async (value) => {
      const ids = [];
      for (const path of splitCategories(value)) ids.push(categoryIdByPath.get(norm(path)) ?? await resolveCategory(path));
      return ids.map((id) => ({ id }));
    },
    tagIds: async (value) => Promise.all(splitList(value, ',').map(async (t) => ({ id: await resolveSimple(tagByName, 'products/tags', 'Etiqueta', t) }))),
    brandIds: async (value) => Promise.all(splitList(value, ',').map(async (b) => ({ id: await resolveSimple(brandByName, 'products/brands', 'Marca', b) }))),
  };
}

// ---------- imágenes: reutiliza las que ya tiene el producto para no duplicarlas ----------
function imagePayload(urls, currentImages) {
  const byUrl = new Map((currentImages || []).filter(Boolean).map((img) => [img.src, img.id]));
  return urls.map((src) => (byUrl.has(src) ? { id: byUrl.get(src) } : { src }));
}

// ---------- atributos de una variación ----------
function variationAttributes(row, parentAttributes) {
  const out = [];
  const add = (names, value) => {
    if (isBlank(value)) return;
    const attr = (parentAttributes || []).find((a) => names.includes(norm(a.name)));
    if (!attr) return;
    const option = norm(value) === ANY ? '' : String(value).trim();
    out.push(attr.id ? { id: attr.id, option } : { name: attr.name, option });
  };
  for (const col of ATTRIBUTE_COLUMNS) add(col.names, row[col.key]);
  for (const part of splitList(row.otherAttributes, ';')) {
    const idx = part.indexOf(':');
    if (idx > 0) add([norm(part.slice(0, idx))], part.slice(idx + 1));
  }
  return out;
}

// ---------- payload de WooCommerce a partir de los campos cambiados ----------
async function buildPayload(item, terms, ctx) {
  const row = item.data;
  const isVariation = item.type === TYPE.variation;
  const keys = new Set(item.changes.map((c) => c.key));
  const p = {};

  if (keys.has('name')) p.name = String(row.name).trim();
  if (keys.has('sku')) p.sku = isBlank(row.sku) ? '' : String(row.sku).trim();
  if (keys.has('status') || item.kind === 'create') {
    const slugs = isVariation ? VARIATION_STATUS_SLUG : PRODUCT_STATUS_SLUG;
    // Producto nuevo sin estado = borrador (no aparece en la tienda hasta revisarlo).
    p.status = slugs[norm(row.status)] || (isVariation ? 'publish' : 'draft');
  }
  if (keys.has('featured')) p.featured = norm(row.featured) === 'sí' || norm(row.featured) === 'si';
  if (keys.has('categories')) p.categories = await terms.categoryIds(row.categories);
  if (keys.has('tags')) p.tags = await terms.tagIds(row.tags);
  if (keys.has('brand')) p.brands = await terms.brandIds(row.brand);
  if (keys.has('shortDescription')) p.short_description = row.shortDescription ?? '';
  if (keys.has('description')) p.description = row.description ?? '';
  if (keys.has('regularPrice')) p.regular_price = str(row.regularPrice);
  if (keys.has('salePrice')) p.sale_price = str(row.salePrice);
  if (keys.has('stock')) {
    if (isBlank(row.stock)) p.manage_stock = false;
    else Object.assign(p, { manage_stock: true, stock_quantity: parseNumber(row.stock) });
  }
  if (keys.has('stockStatus')) p.stock_status = STOCK_STATUS_SLUG[norm(row.stockStatus)];
  if (keys.has('weight')) p.weight = str(row.weight);
  if (['length', 'width', 'height'].some((k) => keys.has(k))) {
    p.dimensions = { length: str(row.length), width: str(row.width), height: str(row.height) };
  }
  const meta = META_COLUMNS.filter((m) => keys.has(m.key)).map((m) => ({ key: m.meta, value: isBlank(row[m.key]) ? '' : String(row[m.key]).trim() }));
  if (meta.length) p.meta_data = meta;

  if (keys.has('images')) {
    const urls = splitList(row.images, ',');
    const current = ctx.storeProduct;
    if (isVariation && item.replaces) {
      // Simple que pasa a variación: reutiliza sus fotos (sin volver a subirlas); la
      // primera es la principal y las demás van a la galería de la variación.
      const [main, ...rest] = imagePayload(urls, item.replaces.product?.images);
      p.image = main || {};
      const gallery = rest.filter((img) => img.id).map((img) => img.id);
      if (gallery.length) p.gallery_image_ids = gallery;
    } else if (isVariation) p.image = urls.length ? imagePayload(urls.slice(0, 1), [ctx.storeVariation?.image])[0] : {};
    else p.images = imagePayload(urls, current?.images);
  }

  if (isVariation) {
    const attrKeys = [...ATTRIBUTE_COLUMNS.map((c) => c.key), 'otherAttributes'];
    if (item.kind === 'create' || attrKeys.some((k) => keys.has(k))) p.attributes = variationAttributes(row, ctx.parentAttributes);
  } else {
    if (item.attributes) p.attributes = item.attributes.map(({ id, name, options, visible, variation, position }) => (id ? { id, options, visible, variation, position } : { name, options, visible, variation, position }));
    if (item.kind === 'create' || keys.has('type')) p.type = item.type === TYPE.variable ? 'variable' : 'simple';
  }
  return p;
}

/**
 * Aplica el plan. Devuelve los ítems con `result`: { ok, message, newId? }.
 * `log` y `onProgress(done, total)` informan el avance.
 */
async function applyPlan(plan, { log = () => {}, onProgress = () => {} } = {}) {
  const live = plan.items.filter((i) => !i.errors.length && i.changes.length);
  const total = live.length;
  let done = 0;
  const tick = (n) => { done += n; onProgress(done, total); };

  const terms = await ensureTerms(plan, log);
  const fail = (item, message) => { item.result = { ok: false, message }; };
  const deletes = live.filter((i) => i.kind === 'delete');
  const saves = live.filter((i) => i.kind !== 'delete');

  // 1. Productos simples y variables.
  const products = saves.filter((i) => i.type !== TYPE.variation);
  const creates = [];
  const updates = [];
  for (const item of products) {
    try {
      const payload = await buildPayload(item, terms, { storeProduct: plan.storeProducts.get(item.id) });
      if (item.kind === 'create') creates.push({ item, payload });
      else updates.push({ item, payload: { id: item.id, ...payload } });
    } catch (error) {
      fail(item, error.message);
    }
  }
  if (creates.length || updates.length) log(`Guardando ${creates.length} producto(s) nuevo(s) y ${updates.length} con cambios...`);
  const res = await store.batch('products', { create: creates.map((c) => c.payload), update: updates.map((u) => u.payload) }, tick);
  creates.forEach(({ item }, i) => {
    const r = res.create[i];
    item.result = r.ok ? { ok: true, message: 'Creado', newId: r.data.id, data: r.data } : { ok: false, message: r.error };
    if (r.ok) plan.storeProducts.set(r.data.id, r.data);
  });
  updates.forEach(({ item }, i) => {
    const r = res.update[i];
    item.result = r.ok ? { ok: true, message: 'Actualizado', data: r.data } : { ok: false, message: r.error };
    // Conserva las variaciones ya consultadas: la respuesta del lote no las trae.
    if (r.ok) plan.storeProducts.set(item.id, { ...r.data, variations_data: plan.storeProducts.get(item.id)?.variations_data });
  });

  // 2. Variaciones, agrupadas por producto padre.
  const idByRow = new Map(plan.items.filter((i) => i.type === TYPE.variable).map((i) => [i.row, i.result?.newId || i.id]));
  const byParent = new Map();
  for (const item of saves.filter((i) => i.type === TYPE.variation)) {
    const parentItem = plan.items.find((i) => i.row === item.parentRow);
    if (parentItem?.result && !parentItem.result.ok) {
      fail(item, 'No se guardó el producto padre; corrige su error y vuelve a subir.');
      tick(1);
      continue;
    }
    const parentId = item.parentId || idByRow.get(item.parentRow);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(item);
  }

  for (const [parentId, items] of byParent) {
    const parent = plan.storeProducts.get(parentId);
    const vCreates = [];
    const vUpdates = [];
    for (const item of items) {
      try {
        const storeVariation = parent?.variations_data?.find((v) => v.id === item.id);
        const payload = await buildPayload(item, terms, { storeProduct: parent, storeVariation, parentAttributes: parent?.attributes });
        if (item.kind === 'create') vCreates.push({ item, payload });
        else vUpdates.push({ item, payload: { id: item.id, ...payload } });
      } catch (error) {
        fail(item, error.message);
        tick(1);
      }
    }
    // Simples que pasan a ser variación: primero se libera su SKU y van a la papelera.
    for (const entry of vCreates.filter((c) => c.item.replaces)) {
      const { replaces } = entry.item;
      try {
        replaces.trashed = await trash.snapshotProduct(replaces.product);
        log(`Mandando a la papelera el producto simple ${replaces.sku || replaces.id} (pasa a variación)...`);
        await trash.trashProduct(replaces.trashed, { clearSku: true });
      } catch (error) {
        replaces.trashed = null;
        fail(entry.item, `No se pudo mandar a la papelera el producto simple ID ${replaces.id}: ${error.message}. No se creó la variación.`);
        entry.skip = true;
        tick(1);
      }
    }
    const toCreate = vCreates.filter((c) => !c.skip);

    log(`Guardando variaciones de "${parent?.name || parentId}"...`);
    const vr = await store.batch(`products/${parentId}/variations`, { create: toCreate.map((c) => c.payload), update: vUpdates.map((u) => u.payload) }, tick);
    for (const [i, { item }] of toCreate.entries()) {
      const r = vr.create[i];
      const replaced = item.replaces?.trashed ? ` (el simple ID ${item.replaces.id} se mandó a la papelera)` : '';
      item.result = r.ok ? { ok: true, message: `Creada${replaced}`, newId: r.data.id, data: r.data } : { ok: false, message: r.error };
      if (r.ok || !item.replaces?.trashed) continue;
      // No se creó la variación: el simple vuelve a como estaba.
      try {
        await trash.restoreProduct(item.replaces.trashed);
        item.result.message += ` El producto simple ID ${item.replaces.id} se restauró como estaba.`;
      } catch (error) {
        item.result.message += ` OJO: el producto simple ID ${item.replaces.id} quedó en la papelera sin SKU (${error.message}). Restáuralo desde WordPress y ponle de nuevo el SKU ${item.replaces.sku}.`;
      }
      item.replaces.trashed = null;
    }
    vUpdates.forEach(({ item }, i) => {
      const r = vr.update[i];
      item.result = r.ok ? { ok: true, message: 'Actualizada', data: r.data } : { ok: false, message: r.error };
    });
  }

  // 3. Papelera (Estado "Eliminar"), con sus traducciones. Al final, para que un
  //    error al guardar lo demás no deje nada a medias.
  if (deletes.length) log(`Mandando a la papelera ${deletes.length} producto(s)/variación(es)...`);
  for (const item of deletes) {
    try {
      if (item.type === TYPE.variation) {
        const parent = plan.storeProducts.get(item.parentId);
        item.trashed = trash.snapshotVariation(parent?.variations_data?.find((v) => v.id === item.id), parent);
        await trash.trashVariation(item.trashed);
        item.result = { ok: true, message: 'Enviada a la papelera' };
      } else {
        item.trashed = await trash.snapshotProduct(plan.storeProducts.get(item.id) || { id: item.id });
        await trash.trashProduct(item.trashed);
        item.result = { ok: true, message: item.type === TYPE.variable ? 'Enviado a la papelera con sus variaciones' : 'Enviado a la papelera' };
      }
    } catch (error) {
      item.trashed = null;
      fail(item, `No se pudo eliminar: ${error.message}`);
    }
    tick(1);
  }

  // Altas que ya existían: no se crean, solo se vincula su ID a la fila.
  const linked = plan.items.filter((i) => i.kind === 'link' && !i.errors.length);
  for (const item of linked) {
    if (!item.result) item.result = { ok: true, message: 'Vinculado (ya existía en la tienda)' };
    else if (item.result.ok) item.result.message += ' (ya existía; vinculado)';
  }

  const ok = live.filter((i) => i.result?.ok).length;
  return {
    summary: {
      'Guardados correctamente': ok,
      'Enviados a la papelera': deletes.filter((i) => i.result?.ok).length + saves.filter((i) => i.result?.ok && i.replaces).length,
      'Vinculados (ya existían)': linked.length,
      'Con error al guardar': live.length - ok,
      'Categorías/etiquetas/marcas creadas': terms.created.length,
    },
    createdTerms: terms.created,
  };
}

module.exports = { applyPlan };
