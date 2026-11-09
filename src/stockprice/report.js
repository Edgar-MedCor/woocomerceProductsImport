// Reporte descargable de una revisión de precios e inventario: qué cambia, qué SKU
// de la web no vinieron en los archivos y cuáles quedan en 0 por el mínimo.
const ExcelJS = require('exceljs');

const NAVY = 'FF1F3A5F';

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.addRows(rows);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };
  return ws;
}

/** @returns Buffer del .xlsx */
async function buildStockReport(plan, report, { warehouses = [], warehouseNames = new Map(), thresholds = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const change = (item, key) => item.changes.find((c) => c.key === key);

  const changed = plan.items.filter((i) => i.changes.length);
  sheet(wb, 'Cambios', [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Producto', key: 'name', width: 40 },
    { header: 'Tipo', key: 'type', width: 11 },
    { header: 'Precio antes', key: 'p0', width: 13 },
    { header: 'Precio nuevo', key: 'p1', width: 13 },
    { header: 'Inventario antes', key: 's0', width: 15 },
    { header: 'Inventario nuevo', key: 's1', width: 15 },
    { header: 'Disponibilidad nueva', key: 'st', width: 18 },
    { header: 'Aviso', key: 'note', width: 50 },
  ], changed.map((i) => {
    const p = change(i, 'regularPrice');
    const s = change(i, 'stock');
    const st = change(i, 'stockStatus');
    return {
      sku: i.data.sku, name: report.names.get(String(i.data.sku)) || i.data.name || '', type: i.type,
      p0: p ? num(p.from) : null, p1: p ? num(p.to) : null, s0: s ? num(s.from) : null, s1: s ? num(s.to) : null, st: st ? st.to : null,
      note: [...i.errors.map((e) => `No se sube: ${e}`), ...i.conflicts.map((c) => `Conflicto: alguien cambió "${c.header}" en la tienda`)].join(' ') || null,
    };
  }));

  const missing = [
    ...report.sinPrecioEnArchivo.map((sku) => [sku, 'No viene en el archivo de precios']),
    ...report.precioVacio.map((sku) => [sku, 'Viene sin precio en el archivo']),
    ...report.sinInventarioEnArchivo.map((sku) => [sku, 'No viene en el archivo de inventario']),
  ].map(([sku, why]) => ({ sku, name: report.names.get(String(sku)) || '', why }));
  sheet(wb, 'No vinieron en los archivos', [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Producto', key: 'name', width: 40 },
    { header: 'Qué pasó (no se actualizó)', key: 'why', width: 36 },
  ], missing);

  sheet(wb, 'En 0 por mínimo', [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Producto', key: 'name', width: 40 },
    { header: 'Categoría', key: 'category', width: 22 },
    { header: 'Total de los almacenes', key: 'total', width: 20 },
    { header: 'Mínimo', key: 'min', width: 10 },
  ], report.zero.map((z) => ({ ...z, name: report.names.get(String(z.sku)) || '' })));

  const params = [
    ['Almacenes sumados', warehouses.map((n) => `${n}${warehouseNames.get(n) ? ` ${warehouseNames.get(n)}` : ''}`).join(', ') || '(no se actualizó inventario)'],
    ...Object.entries(thresholds).sort().map(([cat, min]) => [`Mínimo ${cat}`, min]),
  ];
  const pw = sheet(wb, 'Parámetros', [{ header: 'Dato', key: 'a', width: 30 }, { header: 'Valor', key: 'b', width: 90 }], params.map(([a, b]) => ({ a, b })));
  pw.getColumn(2).alignment = { wrapText: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildStockReport };
