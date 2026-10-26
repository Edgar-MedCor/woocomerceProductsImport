const ExcelJS = require('exceljs');
const { COLUMNS } = require('./layout');

// Valor "plano" de una celda de exceljs (texto enriquecido, hipervínculos y
// fórmulas se convierten a su texto/resultado).
function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return cellValue(value.result);
    if ('text' in value) return cellValue(value.text);
    if (value.error) return null;
    return String(value);
  }
  return value;
}

// Lee una hoja con encabezados en la fila 1 -> [{ _row, key: valor }].
function readSheet(ws, headerToKey) {
  const keys = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    keys[col] = headerToKey(String(cellValue(cell.value) ?? '').trim());
  });

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const out = { _row: rowNumber };
    let hasData = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = keys[col];
      if (!key) return;
      const v = cellValue(cell.value);
      out[key] = typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v;
      if (v !== null && v !== '' && key !== 'modified') hasData = true;
    });
    if (hasData) rows.push(out);
  });
  return { rows, keys };
}

/**
 * Lee el Excel sincronizado: hoja visible "Productos" (lo que editó el equipo),
 * hoja oculta "_base" (lo que se trajo en el último pull) y "_info".
 */
async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const products = wb.getWorksheet('Productos');
  const base = wb.getWorksheet('_base');
  if (!products || !base) {
    throw new Error('El Excel no tiene el formato de Wayan Sync (faltan las hojas "Productos" o "_base"). Haz primero "Traer de la tienda".');
  }

  const byHeader = new Map(COLUMNS.map((c) => [c.header.toLowerCase(), c.key]));
  const editedSheet = readSheet(products, (h) => byHeader.get(h.toLowerCase()) || null);
  const missing = COLUMNS.filter((c) => !editedSheet.keys.includes(c.key)).map((c) => c.header);
  if (missing.includes('ID tienda') || missing.includes('Tipo')) {
    throw new Error(`Faltan columnas en la hoja "Productos": ${missing.join(', ')}. No cambies los encabezados.`);
  }

  const baseSheet = readSheet(base, (h) => (COLUMNS.some((c) => c.key === h) ? h : null));

  const info = {};
  wb.getWorksheet('_info')?.eachRow((row) => { info[cellValue(row.getCell(1).value)] = cellValue(row.getCell(2).value); });

  return { workbook: wb, rows: editedSheet.rows, baseRows: baseSheet.rows, info, missingColumns: missing };
}

module.exports = { readWorkbook, cellValue };
