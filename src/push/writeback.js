// Después del push, actualiza el mismo Excel: ID de los productos creados,
// resultado de cada fila y la hoja oculta "_base" (la nueva "foto"), para que
// lo ya subido no vuelva a detectarse como cambio.
const { COLUMNS, ATTRIBUTE_COLUMNS } = require('../excel/layout');
const { cellValue } = require('../excel/reader');

const RESULT_HEADER = 'Resultado último push';
const FILL = { ok: 'FFC6EFCE', error: 'FFFFC7CE', warn: 'FFFFEB9C' };
const ATTR_FIELDS = [...ATTRIBUTE_COLUMNS.map((c) => c.key), 'otherAttributes'];

function columnIndex(ws, header) {
  let found = null;
  ws.getRow(1).eachCell((cell, col) => {
    if (String(cellValue(cell.value) ?? '').trim().toLowerCase() === header.toLowerCase()) found = col;
  });
  return found;
}

// ID que hay que escribir en la fila: el del producto recién creado o el del ya existente vinculado.
const newIdOf = (item) => (item.result?.ok && item.result.newId) || (item.kind === 'link' && !item.errors.length ? item.id : null);

function resultFor(item, when) {
  if (item.errors.length) return { kind: 'error', text: `✖ No se subió: ${item.errors.join(' ')}` };
  if (item.result && !item.result.ok) return { kind: 'error', text: `✖ Error de la tienda: ${item.result.message}` };
  const parts = [];
  if (item.result?.ok) parts.push(`✔ ${item.result.message} ${when}`);
  if (item.conflicts.length) {
    parts.push(`⚠ No se subió ${item.conflicts.map((c) => `"${c.header}"`).join(', ')}: alguien lo cambió en la tienda. Usa "Traer de la tienda" para ver el valor actual.`);
  }
  if (item.skipped.length) parts.push(`⚠ Sin permiso para: ${item.skipped.map((c) => c.header).join(', ')}`);
  if (!parts.length) return null;
  return { kind: item.conflicts.length || item.skipped.length ? 'warn' : 'ok', text: parts.join(' ') };
}

/** Modifica `excel.workbook` en memoria y devuelve el nuevo contenido del archivo. */
async function writeBack(excel, plan, { when = new Date().toLocaleString('es-MX') } = {}) {
  const ws = excel.workbook.getWorksheet('Productos');
  const base = excel.workbook.getWorksheet('_base');

  // --- Hoja visible: ID nuevo + columna de resultado ---
  const idCol = columnIndex(ws, COLUMNS.find((c) => c.key === 'id').header);
  let resultCol = columnIndex(ws, RESULT_HEADER);
  if (!resultCol) {
    resultCol = ws.actualColumnCount + 1;
    const header = ws.getRow(1).getCell(resultCol);
    header.value = RESULT_HEADER;
    header.style = { ...ws.getRow(1).getCell(1).style };
    ws.getColumn(resultCol).width = 50;
  }
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const cell = ws.getRow(r).getCell(resultCol);
    if (cell.value !== null) {
      cell.value = null;
      cell.fill = { type: 'pattern', pattern: 'none' };
    }
  }

  for (const item of plan.items) {
    if (!item.row) continue;
    const row = ws.getRow(item.row);
    if (newIdOf(item)) row.getCell(idCol).value = newIdOf(item);
    const res = resultFor(item, when);
    if (!res) continue;
    const cell = row.getCell(resultCol);
    cell.value = res.text;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[res.kind] } };
    cell.font = { name: 'Arial', size: 10 };
    cell.alignment = { wrapText: true, vertical: 'top' };
  }

  // --- Hoja oculta _base: la nueva foto ---
  const baseKeys = [];
  base.getRow(1).eachCell((cell, col) => { baseKeys[col] = cellValue(cell.value); });
  const baseCol = Object.fromEntries(baseKeys.map((k, col) => [k, col]).filter(([k]) => k));
  const baseRowById = new Map();
  base.eachRow((row, n) => { if (n > 1) baseRowById.set(String(cellValue(row.getCell(baseCol.id).value)), row); });

  const setBase = (baseRow, key, value) => {
    if (baseCol[key]) baseRow.getCell(baseCol[key]).value = value ?? null;
  };

  for (const item of plan.items) {
    const ok = item.result?.ok;
    const newId = newIdOf(item);
    if (newId && !baseRowById.has(String(newId))) {
      // Producto nuevo: su foto es lo que se subió. Vinculado: lo que tiene la tienda,
      // para que cualquier diferencia con el Excel aparezca en la siguiente revisión.
      const source = item.kind === 'link' && item.linkBase ? item.linkBase : item.data;
      const values = baseKeys.map((key) => (key === 'id' ? newId : source[key] ?? null));
      base.addRow(values.slice(1));
      baseRowById.set(String(newId), null);
      continue;
    }
    const baseRow = baseRowById.get(String(item.id));
    if (!baseRow) continue;
    const keys = new Set(item.synced || []);
    if (ok) {
      item.changes.forEach((c) => keys.add(c.key));
      if (keys.has('attributes')) ATTR_FIELDS.forEach((k) => keys.add(k));
    }
    for (const key of keys) if (key !== 'attributes') setBase(baseRow, key, item.data[key]);
  }

  return Buffer.from(await excel.workbook.xlsx.writeBuffer());
}

module.exports = { writeBack, RESULT_HEADER };
