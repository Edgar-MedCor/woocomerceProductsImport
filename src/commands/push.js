const fs = require('fs');
const path = require('path');
const config = require('../config');
const state = require('../state');
const onedrive = require('../storage/onedrive');
const { readWorkbook } = require('../excel/reader');
const { buildPlan, publicPlan } = require('../push/plan');
const { applyPlan } = require('../push/apply');
const { writeBack } = require('../push/writeback');
const { canonical, normalizeType, isBlank } = require('../push/fields');

const LOCKED_WAIT_MS = 15000;
const LOCKED_MAX_WAITS = 8; // ~2 minutos

/**
 * Paso 1: descarga el Excel y arma el plan (no modifica nada).
 * Devuelve { plan, excel, source } para pasárselo a applyReview.
 */
async function review({ local = null, allowedFields = null, canCreate = true, canDelete = false, log = console.log } = {}) {
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
  const excel = await readWorkbook(buffer);
  log(`Comparando ${excel.rows.length} filas contra el último "Traer de la tienda"...`);
  const plan = await buildPlan(excel, { allowedFields, canCreate, canDelete, log });
  return { plan, excel, source, reviewedAt: new Date() };
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
      const lost = relocateRows(plan, excel);
      if (lost.length) warnings.push(`No se encontró en el Excel la fila de: ${lost.join(', ')}. Ya existen en la tienda; no los vuelvas a dar de alta.`);
    }
  }
  return { summary: applied.summary, createdTerms: applied.createdTerms, warnings };
}

module.exports = { review, applyReview, publicPlan };
