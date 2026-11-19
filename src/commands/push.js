const fs = require('fs');
const path = require('path');
const config = require('../config');
const state = require('../state');
const onedrive = require('../storage/onedrive');
const { readWorkbook } = require('../excel/reader');
const { buildPlan, publicPlan } = require('../push/plan');
const { applyPlan } = require('../push/apply');
const { writeBack } = require('../push/writeback');
const { canonical, normalizeType, isBlank, TYPE } = require('../push/fields');
const { COLUMNS } = require('../excel/layout');
const { cellValue } = require('../excel/reader');
const { stockBySku, skuKey } = require('../stockprice/files');
const store = require('../woo/store');

const LOCKED_WAIT_MS = 15000;
const LOCKED_MAX_WAITS = 8; // ~2 minutos

/**
 * Paso 1: descarga el Excel y arma el plan (no modifica nada).
 * Devuelve { plan, excel, source } para pasárselo a applyReview.
 */
async function loadExcel({ local = null, log = console.log } = {}) {
  let buffer;
  let source;
  if (local) {
    buffer = fs.readFileSync(local);
    source = { local: path.resolve(local) };
  } else {
    const excelPath = config.excelPath();
    const info = await onedrive.getFileInfo(excelPath);
    if (!info) throw new Error(`No existe "${excelPath}" en OneDrive. Haz primero "Traer de la tienda".`);
    log('Descargando el Excel de OneDrive...');
    buffer = await onedrive.downloadFile(excelPath);
    source = { excelPath, eTag: info.eTag, webUrl: info.webUrl, modifiedBy: info.lastModifiedBy?.user?.displayName };
  }
  return { excel: await readWorkbook(buffer), source };
}

async function review({ local = null, allowedFields = null, canCreate = true, canDelete = false, log = console.log } = {}) {
  const { excel, source } = await loadExcel({ local, log });
  log(`Comparando ${excel.rows.length} filas contra el último "Traer de la tienda"...`);
  const plan = await buildPlan(excel, { allowedFields, canCreate, canDelete, log });
  return { plan, excel, source, reviewedAt: new Date() };
}

// ---------- Actualizar precios e inventario con los archivos del sistema ----------
const STOCK_STATUS = { in: 'Disponible', out: 'Agotado' };
const headerOf = (key) => COLUMNS.find((c) => c.key === key).header;

/**
 * Arma las filas a revisar a partir de la foto de la tienda (_base), no de la hoja
 * visible: así solo entran el precio y el inventario de los archivos, y lo que
 * alguien esté editando en el Excel se queda para su propia revisión.
 * Solo productos simples y variaciones con SKU (los padres no tienen precio ni inventario propio).
 */
/**
 * Descuentos (si el archivo de precios trae "PrecioDescuento"):
 *   - Con descuento en el archivo: se pone (y se quitan las fechas de oferta, para que aplique ya).
 *   - Sin descuento en el archivo y con precio rebajado en la tienda:
 *       · si lo puso el panel (está en `panelSales` con ese mismo precio), se quita;
 *       · si quedaría igual o mayor al precio normal nuevo, se quita (si no, Woo lo rechaza);
 *       · si se puso a mano en la tienda, NO se toca: va a `report.manualSales` para que el
 *         usuario elija al subir si lo conserva o regresa al precio normal.
 * `panelSales`: Map(ID tienda -> precio rebajado que puso el panel).
 */
function stockPriceRows(excel, { prices = null, sales = null, panelSales = new Map(), stock = null, warehouses = [], thresholds = {} } = {}) {
  const rowById = new Map(excel.rows.filter((r) => !isBlank(r.id)).map((r) => [String(r.id).trim(), r]));
  const totals = stock ? stockBySku(stock.rows, warehouses, thresholds) : null;
  const report = { sinPrecioEnArchivo: [], precioVacio: [], sinInventarioEnArchivo: [], enCero: [], zero: [], names: new Map(), precios: 0, inventarios: 0, descuentos: sales && prices ? [] : null, quitados: [], manualSales: [] };
  const parentIdBySku = new Map(excel.baseRows.filter((b) => b.type === TYPE.variable).map((b) => [skuKey(b.sku), b.id]));
  const edits = []; // celdas de la hoja visible que se escriben si se sube (para que el Excel quede igual que la tienda)
  const rows = [];
  for (const base of excel.baseRows) {
    const visible = rowById.get(String(base.id));
    if (!visible) continue; // fila borrada del Excel
    const row = { ...base, _row: visible._row };
    rows.push(row);
    if (![TYPE.simple, TYPE.variation].includes(base.type) || isBlank(base.sku) || base.status === 'Eliminar') continue;
    const sku = skuKey(base.sku);
    // Nombre para el reporte: el de la variación es el de su padre.
    report.names.set(String(base.sku), base.name || excel.baseRows.find((b) => b.type === TYPE.variable && skuKey(b.sku) === skuKey(base.parentSku))?.name || '');
    if (prices) {
      if (!prices.has(sku)) report.sinPrecioEnArchivo.push(base.sku);
      else if (prices.get(sku) === null) report.precioVacio.push(base.sku);
      else {
        row.regularPrice = prices.get(sku);
        report.precios += 1;
        edits.push({ id: base.id, key: 'regularPrice', value: row.regularPrice });
        // Precio rebajado (si el archivo trae la columna): con descuento se pone, sin descuento se quita.
        if (sales) {
          const sale = sales.get(sku) || null;
          const current = isBlank(base.salePrice) ? null : Number(base.salePrice);
          const setSale = (value) => {
            row.salePrice = value;
            row._clearSaleDates = true;
            edits.push({ id: base.id, key: 'salePrice', value });
          };
          if (sale) {
            setSale(sale.price);
            report.descuentos.push({ id: base.id, sku: base.sku, regular: row.regularPrice, sale: sale.price, percent: sale.percent, before: current });
          } else if (current !== null) {
            const byPanel = panelSales.get(String(base.id));
            if (byPanel !== undefined && Number(byPanel) === current) {
              setSale(null);
              report.quitados.push({ sku: base.sku, sale: current, why: 'Lo había puesto el panel y ya no viene en el archivo' });
            } else if (current >= row.regularPrice) {
              setSale(null);
              report.quitados.push({ sku: base.sku, sale: current, why: 'Quedaba igual o mayor al precio normal nuevo' });
            } else {
              report.manualSales.push({
                id: base.id, sku: base.sku, type: base.type,
                parentId: base.type === TYPE.variation ? parentIdBySku.get(skuKey(base.parentSku)) ?? null : null,
                regular: row.regularPrice, sale: current, from: null, to: null,
              });
            }
          }
        }
      }
    }
    if (totals) {
      const t = totals.get(sku);
      if (!t) report.sinInventarioEnArchivo.push(base.sku);
      else {
        row.stock = t.quantity;
        row.stockStatus = t.quantity > 0 ? STOCK_STATUS.in : STOCK_STATUS.out;
        report.inventarios += 1;
        if (t.quantity === 0 && t.total > 0) {
          report.enCero.push(`${base.sku} (${t.total} < ${t.min} de ${t.category})`);
          report.zero.push({ sku: base.sku, category: t.category, total: t.total, min: t.min });
        }
        edits.push({ id: base.id, key: 'stock', value: row.stock }, { id: base.id, key: 'stockStatus', value: row.stockStatus });
      }
    }
  }
  return { rows, report, edits };
}

// Escribe en la hoja visible los valores nuevos (fila ubicada por su ID).
function applyCellEdits(excel, edits) {
  if (!edits?.length) return;
  const ws = excel.workbook.getWorksheet('Productos');
  const col = {};
  ws.getRow(1).eachCell((cell, n) => { col[String(cellValue(cell.value) ?? '').trim()] = n; });
  const idCol = col[headerOf('id')];
  const rowById = new Map();
  ws.eachRow((row, n) => { if (n > 1) rowById.set(String(cellValue(row.getCell(idCol).value)).trim(), row); });
  for (const e of edits) {
    const row = rowById.get(String(e.id).trim());
    const c = col[headerOf(e.key)];
    if (row && c) row.getCell(c).value = e.value;
  }
}

const listNote = (title, skus, max = 60) => (skus.length
  ? `${title} (${skus.length}): ${skus.slice(0, max).join(', ')}${skus.length > max ? ` … y ${skus.length - max} más` : ''}.`
  : null);

/** Revisión de precios/inventario: misma revisión, subida, historial y "Deshacer" que el Excel. */
/** Completa los descuentos puestos a mano con lo que hay HOY en la tienda (precio y fechas de oferta). */
async function liveManualSales(list, { log = () => {} } = {}) {
  if (!list.length) return list;
  log(`Consultando en la tienda ${list.length} descuento(s) puestos a mano...`);
  const live = new Map();
  const simple = list.filter((m) => m.type !== TYPE.variation);
  for (const p of await store.fetchProductsByIds(simple.map((m) => m.id))) live.set(String(p.id), p);
  const byParent = new Map();
  for (const m of list.filter((x) => x.type === TYPE.variation && x.parentId)) {
    if (!byParent.has(m.parentId)) byParent.set(m.parentId, []);
    byParent.get(m.parentId).push(m.id);
  }
  for (const [parentId, ids] of byParent) for (const v of await store.fetchVariationsByIds(parentId, ids)) live.set(String(v.id), v);
  const day = (d) => (d ? String(d).slice(0, 10) : null);
  return list.flatMap((m) => {
    const obj = live.get(String(m.id));
    if (!obj) return [m]; // no se pudo consultar: se muestra con lo del Excel
    if (isBlank(obj.sale_price)) return []; // ya no tiene descuento
    return [{ ...m, sale: Number(obj.sale_price), from: day(obj.date_on_sale_from), to: day(obj.date_on_sale_to) }];
  });
}

/**
 * Elecciones del usuario al subir: los descuentos puestos a mano que se regresan a
 * precio normal se agregan al plan (los demás se conservan). Devuelve cuántos.
 */
function applySaleChoices(reviewed, removeIds = []) {
  const manual = new Map((reviewed.report?.manualSales || []).map((m) => [String(m.id), m]));
  let count = 0;
  for (const id of new Set(removeIds.map(String))) {
    const m = manual.get(id);
    if (!m) continue;
    let item = reviewed.plan.items.find((i) => String(i.id) === id);
    if (!item) {
      // Sin otros cambios la fila no está en el plan: se agrega solo para quitar el descuento.
      const base = reviewed.excel.baseRows.find((b) => String(b.id) === id);
      const visible = reviewed.excel.rows.find((r) => String(r.id ?? '').trim() === id);
      if (!base || !visible) continue;
      item = {
        row: visible._row, id: Number(id), data: { ...base, _row: visible._row }, base, type: base.type, kind: 'update',
        parentId: base.type === TYPE.variation ? m.parentId : undefined,
        changes: [], conflicts: [], skipped: [], errors: [], warnings: [], synced: [],
      };
      reviewed.plan.items.push(item);
    }
    if (item.errors.length || item.changes.some((c) => c.key === 'salePrice')) continue;
    item.data.salePrice = null;
    item.data._clearSaleDates = true;
    item.changes.push({ key: 'salePrice', header: headerOf('salePrice'), from: m.sale, to: null });
    const edit = { id: item.id, key: 'salePrice', value: null };
    reviewed.edits.push(edit);
    applyCellEdits(reviewed.excel, [edit]);
    m.removed = true;
    count += 1;
  }
  return count;
}

async function reviewStockPrice({ prices = null, sales = null, panelSales = new Map(), stock = null, warehouses = [], thresholds = {}, allowedFields = null, log = console.log } = {}) {
  if (!prices && !stock) throw new Error('Carga el archivo de precios, el de inventario o los dos.');
  const { excel, source } = await loadExcel({ log });
  log('Cruzando los archivos con los SKU de la tienda...');
  const { rows, report, edits } = stockPriceRows(excel, { prices, sales, panelSales, stock, warehouses, thresholds });
  const plan = await buildPlan({ ...excel, rows }, { allowedFields, canCreate: false, canDelete: false, log });
  applyCellEdits(excel, edits);
  try {
    report.manualSales = await liveManualSales(report.manualSales, { log });
  } catch (error) {
    log(`No se pudieron consultar las fechas de oferta en la tienda (${error.message}); se muestran los precios del Excel.`);
  }
  plan.summary = {
    ...(prices ? { 'SKU de la web con precio en el archivo': report.precios, 'SKU de la web que NO vienen en el archivo de precios (no se actualizan)': report.sinPrecioEnArchivo.length } : {}),
    ...(prices && sales ? {
      'SKU de la web con descuento (precio rebajado)': report.descuentos.length,
      'Descuentos que se quitan (los puso el panel y ya no vienen en el archivo)': report.quitados.length,
      'Descuentos puestos a mano en la tienda (tú eliges si se conservan)': report.manualSales.length,
    } : {}),
    ...(stock ? { 'SKU de la web con inventario en el archivo': report.inventarios, 'SKU de la web que NO vienen en el archivo de inventario (no se actualizan)': report.sinInventarioEnArchivo.length, 'Inventario en 0 por estar debajo del mínimo de su categoría': report.enCero.length } : {}),
    ...plan.summary,
  };
  plan.notes = [
    listNote('No vienen en el archivo de precios, su precio no se actualiza', report.sinPrecioEnArchivo),
    listNote('Vienen sin precio en el archivo, su precio no se actualiza', report.precioVacio),
    prices && !sales ? 'El archivo de precios no trae las columnas de descuento (PorcentajeDescuento / PrecioDescuento): solo se actualiza el precio normal; los precios rebajados de la tienda no se tocan.' : null,
    prices && sales && !report.manualSales.length ? 'No hay descuentos puestos a mano en la tienda que falten en el archivo: no hay nada que elegir.' : null,
    prices && sales ? 'El archivo de precios trae descuentos: se pone el precio rebajado a los que tienen descuento (de inmediato, sin fechas). Los descuentos que puso el panel y ya no vienen en el archivo se quitan; los que se pusieron a mano en la tienda no se tocan, a menos que elijas regresarlos a precio normal en la lista de abajo.' : null,
    listNote('Se quita el precio rebajado', report.quitados.map((q) => `${q.sku} (${q.why.toLowerCase()})`), 40),
    listNote('No vienen en el archivo de inventario, su inventario no se actualiza', report.sinInventarioEnArchivo),
    listNote('Se publican con inventario 0 por estar debajo del mínimo de su categoría', report.enCero, 40),
    stock ? `Inventario = suma de los almacenes ${[...warehouses].sort((a, b) => a - b).join(', ')}.` : null,
    ...plan.notes,
  ].filter(Boolean);
  return { plan, excel, source, edits, report, reviewedAt: new Date() };
}

// Si el Excel cambió durante el push, ubica cada fila del plan en la versión nueva.
function relocateRows(plan, freshExcel) {
  const lost = [];
  const key = (r) => [canonical('sku', r.sku), canonical('name', r.name), normalizeType(r.type) || ''].join('|');
  for (const item of plan.items) {
    const sameRow = freshExcel.rows.find((r) => r._row === item.row);
    if (sameRow && key(sameRow) === key(item.data)) continue;
    const bySku = isBlank(item.data.sku) ? [] : freshExcel.rows.filter((r) => canonical('sku', r.sku) === canonical('sku', item.data.sku));
    if (bySku.length === 1) {
      item.row = bySku[0]._row;
    } else {
      if (item.result?.newId) lost.push(`${item.data.name || item.data.sku || `fila ${item.row}`} (ID ${item.result.newId})`);
      item.row = null; // no escribir el resultado en una fila equivocada
    }
  }
  return lost;
}

/** Paso 2: aplica un plan revisado en la tienda y escribe el resultado en el Excel. */
async function applyReview(reviewed, { log = console.log, onProgress = () => {} } = {}) {
  const { plan, source } = reviewed;
  let { excel } = reviewed;

  if (!source.local) {
    const info = await onedrive.getFileInfo(source.excelPath);
    if (info?.eTag !== source.eTag) {
      const err = new Error('El Excel cambió después de "Revisar cambios". Vuelve a revisar para incluir lo último que se editó.');
      err.code = 'EXCEL_CHANGED';
      throw err;
    }
  }

  const applied = await applyPlan(plan, { log, onProgress });
  const when = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  const warnings = [];

  log('Escribiendo el resultado en el Excel...');
  if (source.local) {
    fs.writeFileSync(source.local, await writeBack(excel, plan, { when }));
    return { summary: applied.summary, createdTerms: applied.createdTerms, warnings };
  }

  // Sube solo si nadie editó el Excel mientras tanto; si sí, reintenta sobre la versión nueva.
  let eTag = source.eTag;
  let conflicts = 0;
  let lockedWaits = 0;
  for (;;) {
    const buffer = await writeBack(excel, plan, { when });
    try {
      const uploaded = await onedrive.uploadFile(source.excelPath, buffer, { ifMatch: eTag });
      state.set(source.excelPath, { ...state.get(source.excelPath), eTag: uploaded.eTag, webUrl: uploaded.webUrl });
      return { summary: applied.summary, createdTerms: applied.createdTerms, warnings, webUrl: uploaded.webUrl };
    } catch (error) {
      // 423: el archivo está abierto en Excel de escritorio y OneDrive lo bloquea.
      if (error.status === 423 && lockedWaits < LOCKED_MAX_WAITS) {
        lockedWaits += 1;
        if (lockedWaits === 1) log('El Excel está abierto en Excel de escritorio y OneDrive no deja actualizarlo. Ciérralo; reintentando cada 15 segundos...');
        await new Promise((r) => setTimeout(r, LOCKED_WAIT_MS));
        continue;
      }
      if (error.status !== 412 || conflicts >= 2) {
        warnings.push(error.status === 423
          ? 'Los cambios SÍ se guardaron en la tienda, pero el Excel sigue abierto en Excel de escritorio y no se pudo actualizar. Ciérralo y haz "Revisar cambios" otra vez: los productos ya creados se reconocen por su SKU y se vinculan solos, no se duplican.'
          : `Los cambios SÍ se guardaron en la tienda, pero no se pudo actualizar el Excel: ${error.message}. Haz "Revisar cambios" otra vez: los productos ya creados se reconocen por su SKU y se vinculan solos.`);
        return { summary: applied.summary, createdTerms: applied.createdTerms, warnings };
      }
      conflicts += 1;
      log('Alguien editó el Excel durante la subida; aplicando el resultado sobre la versión más reciente...');
      const info = await onedrive.getFileInfo(source.excelPath);
      eTag = info.eTag;
      excel = await readWorkbook(await onedrive.downloadFile(source.excelPath));
      applyCellEdits(excel, reviewed.edits);
      const lost = relocateRows(plan, excel);
      if (lost.length) warnings.push(`No se encontró en el Excel la fila de: ${lost.join(', ')}. Ya existen en la tienda; no los vuelvas a dar de alta.`);
    }
  }
  return { summary: applied.summary, createdTerms: applied.createdTerms, warnings };
}

module.exports = { review, reviewStockPrice, stockPriceRows, applySaleChoices, liveManualSales, applyCellEdits, applyReview, publicPlan };
