// Reporte descargable de los productos sin foto principal en la tienda, en
// cualquier estado (ver photos/missing.js). Lee la tienda en vivo; no modifica nada.
const ExcelJS = require('exceljs');
const media = require('../woo/media');
const { findShownWithoutPhotos, photoSources } = require('./missing');

const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const stockOf = (x) => (x.manage_stock && x.stock_quantity != null ? Number(x.stock_quantity) : null);

// Qué hará "Revisar fotos" con este producto.
function fix(p, src) {
  if (p.type !== 'variable') return src.media.length ? 'Sí: tiene fotos en Medios' : 'No: faltan fotos';
  if (src.withPhoto) return 'Sí: se arma la galería con las fotos de sus variaciones';
  if (src.media.length) return `Sí: fotos en Medios para ${src.media.length} de ${src.total} variación(es)`;
  return src.total ? 'No: faltan fotos' : 'No: no tiene variaciones';
}

async function buildNoPhotosReport({ log = () => {}, progress = () => {} } = {}) {
  log('Leyendo los productos de la tienda...');
  const bare = await findShownWithoutPhotos({ progress });
  log('Leyendo los nombres de las fotos en Medios...');
  await media.refreshMediaIndex({ onProgress: (n, total) => progress(n, total, 'Imágenes de Medios leídas') });

  const rows = bare.map((p) => {
    const variations = p.variations_data || [];
    const stock = p.type === 'variable' ? variations.map(stockOf).filter((n) => n != null) : [stockOf(p)].filter((n) => n != null);
    const src = photoSources(p);
    return {
      sku: p.sku || '(sin SKU)',
      nombre: p.name,
      inventario: stock.length ? stock.reduce((a, b) => a + b, 0) : null,
      estado: STATUS[p.status] || p.status,
      tipo: p.type === 'variable' ? (variations.length ? `Variable (${variations.length} variaciones)` : 'Variable (sin variaciones)') : 'Simple',
      categoria: (p.categories || []).map((c) => c.name).join(', '),
      arregla: fix(p, src),
    };
  }).sort((a, b) => a.categoria.localeCompare(b.categoria, 'es') || a.nombre.localeCompare(b.nombre, 'es'));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sin fotos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Nombre', key: 'nombre', width: 48 },
    { header: 'Inventario', key: 'inventario', width: 11 },
    { header: 'Estado', key: 'estado', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 26 },
    { header: 'Categoría', key: 'categoria', width: 28 },
    { header: '¿Lo arregla "Revisar fotos"?', key: 'arregla', width: 52 },
  ];
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  ws.autoFilter = { from: 'A1', to: `G${rows.length + 1}` };

  const count = (f) => rows.filter(f).length;
  return {
    buffer: await wb.xlsx.writeBuffer(),
    summary: {
      'Productos sin foto': rows.length,
      Publicados: count((r) => r.estado === 'Publicado'),
      'En revisión': count((r) => r.estado === 'En revisión'),
      Borrador: count((r) => r.estado === 'Borrador'),
      Simples: count((r) => r.tipo === 'Simple'),
      Variables: count((r) => r.tipo.startsWith('Variable')),
      'Con inventario': count((r) => r.inventario > 0),
      'Los arregla "Revisar fotos" (Medios o galería del padre)': count((r) => r.arregla.startsWith('Sí')),
      'Faltan fotos (hay que tomarlas o subirlas)': count((r) => r.arregla.startsWith('No')),
    },
  };
}

module.exports = { buildNoPhotosReport };
