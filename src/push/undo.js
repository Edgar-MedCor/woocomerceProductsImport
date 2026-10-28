// "Deshacer último push": regresa la tienda a como estaba antes de ese push,
// con su respaldo (push_backups). Nunca pisa algo que se cambió después:
// cada campo se restaura solo si sigue con el valor que dejó el push.
const config = require('../config');
const state = require('../state');
const store = require('../woo/store');
const onedrive = require('../storage/onedrive');
const { catalogToRows, COLUMNS } = require('../excel/layout');
const { readWorkbook, cellValue } = require('../excel/reader');
const { RESULT_HEADER } = require('./writeback');
const { pick, sameValue, toPayload } = require('./backup');
const trash = require('./trash');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined ? null : Number(v));
const skuKey = (v) => String(v ?? '').trim().toUpperCase();

async function fetchState(backups) {
  const products = new Map();
  const variations = new Map();
  const productIds = backups.filter((b) => b.kind === 'product').map((b) => num(b.woo_id));
  for (const p of productIds.length ? await store.fetchProductsByIds(productIds) : []) products.set(p.id, p);
  const byParent = new Map();
  for (const b of backups.filter((x) => x.kind === 'variation')) {
    const parentId = num(b.parent_id);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(num(b.woo_id));
  }
  for (const [parentId, ids] of byParent) {
    // Si el padre ya no existe, sus variaciones tampoco.
    const list = await store.fetchVariationsByIds(parentId, ids).catch((e) => (e.response?.status === 404 ? [] : Promise.reject(e)));
    for (const v of list) variations.set(v.id, v);
  }
  return { products, variations };
}

/**
 * Orden: 1) borra lo que el push creó (libera SKUs), 2) restaura campos y
 * 3) saca de la papelera lo que el push eliminó o reemplazó.
 * @returns { results: [{ sku, ok, message }], refreshed: { productIds, variations, deletedIds, restored } }
 */
async function undoInStore(backups, { log = () => {}, progress = () => {} } = {}) {
  const now = await fetchState(backups.filter((b) => b.action !== 'delete'));
  const current = (b) => (b.kind === 'product' ? now.products : now.variations).get(num(b.woo_id));
  const results = [];
  const label = (b) => b.sku || `ID ${b.woo_id}`;
  let done = 0;
  const tick = () => progress(++done, backups.length, 'Deshaciendo');

  // 1. Borrar lo que el push creó (variaciones primero; si su padre también se
  //    creó en ese push, se borran junto con él). Solo si nadie lo editó después.
  const deletedIds = [];
  const createdProducts = new Set(backups.filter((b) => b.action === 'create' && b.kind === 'product').map((b) => num(b.woo_id)));
  const creates = backups.filter((b) => b.action === 'create')
    .sort((a, b) => (a.kind === 'variation' ? 0 : 1) - (b.kind === 'variation' ? 0 : 1));
  for (const b of creates) {
    const id = num(b.woo_id);
    const cur = current(b);
    if (b.kind === 'variation' && createdProducts.has(num(b.parent_id))) {
      deletedIds.push(id); // se borra con su padre
      tick();
      continue;
    }
    if (!cur) {
      results.push({ sku: label(b), ok: true, message: 'Ya no existía en la tienda.' });
      deletedIds.push(id);
      tick();
      continue;
    }
    if (b.after?.date_modified && cur.date_modified !== b.after.date_modified) {
      results.push({ sku: label(b), ok: false, message: 'No se borró: alguien lo modificó después del push. Bórralo a mano si ya no se necesita.' });
      tick();
      continue;
    }
    try {
      const endpoint = b.kind === 'product' ? `products/${id}` : `products/${num(b.parent_id)}/variations/${id}`;
      await store.request('delete', endpoint, { force: true }, undefined, 1);
      results.push({ sku: label(b), ok: true, message: 'Borrado (lo había creado el push).' });
      deletedIds.push(id);
    } catch (error) {
      results.push({ sku: label(b), ok: false, message: `No se pudo borrar: ${error.response?.data?.message || error.message}` });
    }
    tick();
  }

  // 2. Restaurar campos de lo que se modificó.
  const productUpdates = [];
  const variationUpdates = new Map();
  for (const b of backups.filter((x) => x.action === 'update')) {
    const cur = current(b);
    if (!cur) {
      results.push({ sku: label(b), ok: false, message: 'Ya no existe en la tienda; no se restauró.' });
      tick();
      continue;
    }
    const restore = [];
    const changedLater = [];
    for (const field of b.fields) {
      const value = pick(cur, field);
      if (sameValue(field, value, b.after[field])) restore.push(field);
      else if (!sameValue(field, value, b.before[field])) changedLater.push(field);
    }
    const note = changedLater.length ? ` No se tocó ${changedLater.join(', ')}: alguien lo volvió a cambiar después del push.` : '';
    if (!restore.length) {
      results.push({ sku: label(b), ok: !changedLater.length, message: changedLater.length ? `Sin restaurar.${note}` : 'Ya estaba como antes.' });
      tick();
      continue;
    }
    const entry = { b, note, payload: { id: num(b.woo_id), ...toPayload(b.before, restore) } };
    if (b.kind === 'product') productUpdates.push(entry);
    else {
      const parentId = num(b.parent_id);
      if (!variationUpdates.has(parentId)) variationUpdates.set(parentId, []);
      variationUpdates.get(parentId).push(entry);
    }
  }

  const sendRestores = async (endpoint, entries) => {
    const res = await store.batch(endpoint, { update: entries.map((e) => e.payload) });
    entries.forEach(({ b, note }, i) => {
      const r = res.update[i];
      results.push({ sku: label(b), ok: r.ok, message: r.ok ? `Restaurado.${note}` : `No se pudo restaurar: ${r.error}` });
      tick();
    });
  };
  if (productUpdates.length) {
    log(`Restaurando ${productUpdates.length} producto(s)...`);
    await sendRestores('products', productUpdates);
  }
  for (const [parentId, entries] of variationUpdates) {
    log(`Restaurando ${entries.length} variación(es) del producto ${parentId}...`);
    await sendRestores(`products/${parentId}/variations`, entries);
  }

  // 3. Sacar de la papelera (con sus traducciones) lo que el push eliminó.
  const restored = [];
  const trashed = backups.filter((b) => b.action === 'delete');
  if (trashed.length) log(`Sacando de la papelera ${trashed.length} producto(s)/variación(es)...`);
  for (const b of trashed) {
    try {
      if (b.kind === 'product') await trash.restoreProduct(b.before.versions);
      else await trash.restoreVariation(b.before.versions);
      results.push({ sku: label(b), ok: true, message: 'Restaurado de la papelera.' });
      restored.push({ id: num(b.woo_id), kind: b.kind, parentId: num(b.parent_id), sku: b.sku });
    } catch (error) {
      results.push({ sku: label(b), ok: false, message: `No se pudo sacar de la papelera (¿la vaciaron?): ${error.response?.data?.message || error.message}` });
    }
    tick();
  }

  const refreshed = {
    productIds: backups.filter((b) => b.kind === 'product' && b.action === 'update').map((b) => num(b.woo_id)),
    variations: backups.filter((b) => b.kind === 'variation' && b.action === 'update').map((b) => ({ id: num(b.woo_id), parentId: num(b.parent_id) })),
    deletedIds,
    restored,
  };
  return { results, refreshed };
}

// Pone al día en el Excel (hoja visible y foto oculta) las filas que tocó el deshacer.
async function refreshExcel(refreshed, { log = () => {} } = {}) {
  const { deletedIds, restored = [] } = refreshed;
  // Lo restaurado de la papelera se pone al día igual que lo restaurado campo por campo.
  const productIds = [...refreshed.productIds, ...restored.filter((r) => r.kind === 'product').map((r) => r.id)];
  const variations = [...refreshed.variations, ...restored.filter((r) => r.kind === 'variation').map((r) => ({ id: r.id, parentId: r.parentId }))];
  if (!productIds.length && !variations.length && !deletedIds.length) return { webUrl: null };
  const excelPath = config.excelPath();

  const taxonomies = await store.fetchTaxonomies();
  const parentIds = [...new Set(variations.map((v) => v.parentId))];
  const products = await store.fetchProductsByIds([...new Set([...productIds, ...parentIds])]);
  for (const p of products) {
    const ids = variations.filter((v) => v.parentId === p.id).map((v) => v.id);
    p.variations_data = ids.length ? await store.fetchVariationsByIds(p.id, ids) : [];
  }
  const wanted = new Set([...productIds, ...variations.map((v) => v.id)]);
  const storeRows = new Map(catalogToRows({ products, categories: taxonomies.categories }).filter((r) => wanted.has(r.id)).map((r) => [r.id, r]));
  const deleted = new Set(deletedIds);
  const when = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const info = await onedrive.getFileInfo(excelPath);
    if (!info) return { webUrl: null };
    const excel = await readWorkbook(await onedrive.downloadFile(excelPath));
    const ws = excel.workbook.getWorksheet('Productos');
    const base = excel.workbook.getWorksheet('_base');

    const visibleCol = {};
    let resultCol = null;
    ws.getRow(1).eachCell((cell, col) => {
      const header = String(cellValue(cell.value) ?? '').trim();
      const column = COLUMNS.find((c) => c.header === header);
      if (column) visibleCol[column.key] = col;
      if (header === RESULT_HEADER) resultCol = col;
    });
    const fill = (row, data, text) => {
      for (const [key, col] of Object.entries(visibleCol)) row.getCell(col).value = data[key] ?? null;
      if (resultCol) row.getCell(resultCol).value = text;
    };
    const seen = new Set();
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const id = num(cellValue(row.getCell(visibleCol.id).value));
      if (!id) continue;
      if (storeRows.has(id)) {
        seen.add(id);
        fill(row, storeRows.get(id), `↩ Deshecho ${when}: valores anteriores restaurados`);
      } else if (deleted.has(id)) {
        row.getCell(visibleCol.id).value = null;
        if (resultCol) row.getCell(resultCol).value = `↩ Deshecho ${when}: se borró de la tienda (si lo vuelves a subir, se creará de nuevo)`;
      }
    }
    // Un simple que había pasado a variación ya no tiene su ID en el Excel: su fila
    // (ahora sin ID, porque la variación se borró) se ubica por el SKU.
    for (const r of restored.filter((x) => !seen.has(x.id) && storeRows.has(x.id) && x.sku)) {
      for (let n = 2; n <= ws.rowCount; n += 1) {
        const row = ws.getRow(n);
        if (cellValue(row.getCell(visibleCol.id).value) || skuKey(cellValue(row.getCell(visibleCol.sku).value)) !== skuKey(r.sku)) continue;
        fill(row, storeRows.get(r.id), `↩ Deshecho ${when}: se sacó de la papelera`);
        break;
      }
    }

    const baseCol = {};
    base.getRow(1).eachCell((cell, col) => { baseCol[cellValue(cell.value)] = col; });
    const toRemove = [];
    const inBase = new Set();
    base.eachRow((row, n) => {
      if (n === 1) return;
      const id = num(cellValue(row.getCell(baseCol.id).value));
      if (storeRows.has(id)) {
        inBase.add(id);
        const data = storeRows.get(id);
        for (const [key, col] of Object.entries(baseCol)) row.getCell(col).value = data[key] ?? null;
      } else if (deleted.has(id)) toRemove.push(n);
    });
    toRemove.sort((a, b) => b - a).forEach((n) => base.spliceRows(n, 1));
    for (const r of restored.filter((x) => !inBase.has(x.id) && storeRows.has(x.id))) {
      const values = [];
      for (const [key, col] of Object.entries(baseCol)) values[col - 1] = storeRows.get(r.id)[key] ?? null;
      base.addRow(values);
    }

    try {
      const uploaded = await onedrive.uploadFile(excelPath, Buffer.from(await excel.workbook.xlsx.writeBuffer()), { ifMatch: info.eTag });
      state.set(excelPath, { ...state.get(excelPath), eTag: uploaded.eTag, webUrl: uploaded.webUrl });
      return { webUrl: uploaded.webUrl };
    } catch (error) {
      if (error.status === 412) { log('Alguien editó el Excel mientras tanto; reintentando sobre la versión más reciente...'); continue; }
      if (error.status === 423 && attempt < 10) { log('El Excel está abierto y bloqueado; reintentando en 15 s (ciérralo si está abierto en Excel de escritorio)...'); await sleep(15000); continue; }
      throw error;
    }
  }
  throw new Error('No se pudo actualizar el Excel después de varios intentos.');
}

module.exports = { undoInStore, refreshExcel };
