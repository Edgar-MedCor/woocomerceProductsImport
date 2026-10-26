const ExcelJS = require('exceljs');
const { COLUMNS, TYPE, STOCK_STATUS, PRODUCT_STATUS, VARIATION_STATUS, YES_NO } = require('./layout');

const FONT = 'Arial';
const NEW_ROWS = 2000; // filas vacías con listas desplegables para altas nuevas
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFD0D5DD' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };

const FILL = {
  simple: 'FFE6F4EA', // verde: producto simple
  variable: 'FFDCE8F7', // azul: padre con variantes
  variableEmpty: 'FFFFE4E1', // rojo claro: padre sin variantes (nadie lo puede comprar)
  variation: 'FFFFFFFF',
  notApplicable: 'FFF1F3F5', // gris: celda que no aplica a ese tipo de fila
};
const STOCK_COLOR = {
  Disponible: ['FFC6EFCE', 'FF006100'],
  Agotado: ['FFFFC7CE', 'FF9C0006'],
  'Sobre pedido': ['FFE4DFEC', 'FF5B3A8C'],
};

const rowKind = (r) => {
  if (r.type === TYPE.simple) return 'simple';
  if (r.type === TYPE.variation) return 'variation';
  return r._variationCount === 0 ? 'variableEmpty' : 'variable';
};

// ¿La columna aplica a este tipo de fila?
function applies(col, kind) {
  if (col.level === 'all') return true;
  if (col.level === 'product') return kind !== 'variation';
  if (col.level === 'variation') return kind === 'variation';
  if (col.level === 'priced') return kind === 'simple' || kind === 'variation';
  return true;
}

const list = (values) => ({
  type: 'list',
  allowBlank: true,
  formulae: [`"${values.join(',')}"`],
  showErrorMessage: true,
  errorTitle: 'Valor no válido',
  error: `Elige una opción de la lista: ${values.join(', ')}`,
});

function addInstructions(wb, meta) {
  const ws = wb.addWorksheet('Instrucciones');
  ws.columns = [{ width: 30 }, { width: 100 }];
  const lines = [
    ['Catálogo de productos — Wayan', null, { size: 16, color: { argb: 'FF1F3A5F' } }],
    [`Traído de ${meta.source} el ${meta.pulledAt}`, null, { bold: false, italic: true, color: { argb: 'FF5B6B7F' } }],
    [],
    ['Tipos de fila', null, { color: { argb: 'FF1F3A5F' } }],
    ['Variable', 'Azul. El producto "general" (ej. un vestido). Lleva nombre, categorías, etiquetas, descripciones e imágenes. En Color/Talla van TODAS las opciones separadas por " | " (ej. CH | M | G).', null, FILL.variable],
    ['Variación', 'Blanco. Cada combinación que se vende (ej. talla M). Va debajo de su padre y lleva el SKU del padre en "SKU padre", su propio SKU, precio, inventario y su valor de Color/Talla.', null, FILL.variation],
    ['Simple', 'Verde. Producto sin variantes: se vende tal cual.', null, FILL.simple],
    ['Variable (rojo)', 'Padre que no tiene ninguna variación: nadie lo puede comprar. Hay que agregarle variaciones o cambiarlo a borrador.', null, FILL.variableEmpty],
    ['Celdas grises', 'No aplican a ese tipo de fila (ej. el precio de un Variable va en cada variación). Lo que escribas ahí se ignora.', null, FILL.notApplicable],
    [],
    ['Qué se puede editar', null, { color: { argb: 'FF1F3A5F' } }],
    ['Encabezado azul', 'Se puede editar. Categorías y Etiquetas son las que agrupan los productos en la web.'],
    ['Encabezado gris', 'No editar (ID tienda, último cambio). Sirven para identificar cada producto.'],
    ['Categorías', 'Ruta completa con " > " y varias separadas por coma. Ej: DAMA > COMPLETOS > VESTIDOS, NUEVO'],
    ['Etiquetas / Imágenes', 'Varias separadas por coma. En imágenes, la primera URL es la foto principal.'],
    ['Inventario', 'Número de piezas. Vacío = la tienda no lleva conteo (se usa "Disponibilidad").'],
    ['Medidas de prenda', 'Línea, Ancho pecho, Largo, etc. se guardan en cada producto/variante.'],
    ['No borres filas', 'Borrar una fila NO borra el producto de la tienda. Para ocultarlo cambia su Estado a "Borrador" (o "Desactivada" en variaciones).'],
    [],
    ['Dar de alta productos nuevos', null, { color: { argb: 'FF1F3A5F' } }],
    ['Cómo', 'Agrega filas al final dejando "ID tienda" vacío. Elige el Tipo. Para un producto con variantes: primero la fila Variable y debajo sus Variación con el mismo "SKU padre".'],
    [],
    ['Navegar', null, { color: { argb: 'FF1F3A5F' } }],
    ['Contraer / expandir', 'Botones [1] y [2] arriba a la izquierda de la hoja "Productos": [1] solo padres y simples, [2] con variaciones.'],
  ];
  lines.forEach(([a, b, font, fill], i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = a ?? null;
    row.getCell(2).value = b ?? null;
    row.getCell(1).font = { name: FONT, bold: true, ...(font || {}) };
    row.getCell(2).font = { name: FONT };
    row.getCell(1).alignment = { vertical: 'top' };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    if (fill) row.getCell(1).fill = solid(fill);
  });
}

function addProductsSheet(wb, rows) {
  const ws = wb.addWorksheet('Productos', {
    views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }],
    properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
  });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  const header = ws.getRow(1);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = solid(c.editable ? 'FF1F3A5F' : 'FF8A94A6');
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER;
  });
  header.height = 45;

  const colIndex = (key) => COLUMNS.findIndex((c) => c.key === key) + 1;

  rows.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    const kind = rowKind(r);
    COLUMNS.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      const ok = applies(c, kind);
      cell.value = r[c.key] ?? null;
      cell.fill = solid(ok ? FILL[kind] : FILL.notApplicable);
      cell.border = BORDER;
      cell.font = {
        name: FONT,
        size: 10,
        bold: kind !== 'variation' && c.key === 'name',
        color: { argb: ok && c.editable ? 'FF000000' : 'FF8A94A6' },
      };
      if (c.format) cell.numFmt = c.format;
      cell.alignment = { vertical: 'top', wrapText: ['name', 'shortDescription', 'description'].includes(c.key) };
    });
    if (kind === 'variation') row.outlineLevel = 1;

    const stockCell = row.getCell(colIndex('stockStatus'));
    const [bg, fg] = STOCK_COLOR[r.stockStatus] || [];
    if (bg) {
      stockCell.fill = solid(bg);
      stockCell.font = { name: FONT, size: 10, bold: true, color: { argb: fg } };
    }
  });

  // Listas desplegables para las filas existentes y para las altas nuevas.
  const last = rows.length + 1 + NEW_ROWS;
  const range = (key) => {
    const letter = ws.getColumn(colIndex(key)).letter;
    return `${letter}2:${letter}${last}`;
  };
  ws.dataValidations.add(range('type'), list(Object.values(TYPE)));
  ws.dataValidations.add(range('status'), list([...Object.values(PRODUCT_STATUS), ...Object.values(VARIATION_STATUS)]));
  ws.dataValidations.add(range('featured'), list(Object.values(YES_NO)));
  ws.dataValidations.add(range('stockStatus'), list(Object.values(STOCK_STATUS)));

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: COLUMNS.length } };
}

// Copia oculta de lo que se trajo de la tienda: es la "base" contra la que el
// push detectará qué cambió el equipo en el Excel (como el último commit en git).
function addBaseSheet(wb, rows, meta) {
  const ws = wb.addWorksheet('_base', { state: 'veryHidden' });
  ws.addRow(COLUMNS.map((c) => c.key));
  rows.forEach((r) => ws.addRow(COLUMNS.map((c) => r[c.key] ?? null)));

  const info = wb.addWorksheet('_info', { state: 'veryHidden' });
  Object.entries(meta).forEach(([k, v]) => info.addRow([k, v]));
}

async function buildWorkbook(rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'wayan-sync';
  addInstructions(wb, meta);
  addProductsSheet(wb, rows);
  addBaseSheet(wb, rows, meta);
  wb.views = [{ activeTab: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook };
