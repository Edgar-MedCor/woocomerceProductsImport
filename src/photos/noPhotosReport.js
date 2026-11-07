// Reporte descargable de lo que no tiene foto en la tienda: productos simples,
// variaciones y productos variables sin foto principal. Lee la tienda en vivo
// (no el Excel) y solo lee; no modifica nada.
const ExcelJS = require('exceljs');
const config = require('../config');
const store = require('../woo/store');
const media = require('../woo/media');

const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
// estilo (letras+números) + talla (letras) + color (2 o 3 dígitos)
const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;

async function withConcurrency(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// ¿Hay fotos en Medios con el nombre SKU-1… o estilo+color-1…?
function inMedia(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) return 'No';
  if (media.mediaFor(code).length) return 'Sí';
  const m = code.match(SKU_PARTS);
  return m && media.mediaFor(m[1] + m[3]).length ? 'Sí (estilo+color)' : 'No';
}

const stockOf = (x) => (x.manage_stock && x.stock_quantity != null ? Number(x.stock_quantity) : null);

async function buildNoPhotosReport({ log = () => {}, progress = () => {} } = {}) {
  log('Leyendo los productos de la tienda...');
  const products = await store.fetchProductsWithStock();
  log('Leyendo los nombres de las fotos en Medios...');
  await media.refreshMediaIndex({ onProgress: (n, total) => progress(n, total, 'Imágenes de Medios leídas') });

  const rows = [];
  for (const p of products.filter((x) => x.type !== 'variable' && !(x.images || []).length)) {
    rows.push({ tipo: 'Simple', sku: p.sku, nombre: p.name, inventario: stockOf(p), estado: STATUS[p.status] || p.status, padre: null, categoria: (p.categories || []).map((c) => c.name).join(', '), medios: inMedia(p.sku) });
  }

  const variables = products.filter((x) => x.type === 'variable');
  let done = 0;
  await withConcurrency(variables, config.photos.concurrency, async (p) => {
    const variations = p.variations?.length ? await store.fetchAllVariations(p.id) : [];
    const categoria = (p.categories || []).map((c) => c.name).join(', ');
    if (!(p.images || []).length) {
      const stock = variations.map(stockOf).filter((n) => n != null);
      rows.push({
        tipo: variations.length ? 'Variable' : 'Variable (sin variaciones)', sku: p.sku, nombre: p.name,
        inventario: stock.length ? stock.reduce((a, b) => a + b, 0) : null, estado: STATUS[p.status] || p.status, padre: null, categoria, medios: inMedia(p.sku),
      });
    }
    for (const v of variations.filter((x) => !x.image?.id)) {
      const opciones = (v.attributes || []).map((a) => a.option).filter(Boolean).join(' / ');
      rows.push({
        tipo: 'Variación', sku: v.sku || '(sin SKU)', nombre: opciones ? `${p.name} - ${opciones}` : p.name, inventario: stockOf(v),
        estado: v.status === 'private' ? 'Desactivada' : STATUS[p.status] || p.status, padre: p.sku, categoria, medios: inMedia(v.sku),
      });
    }
    done += 1;
    progress(done, variables.length, 'Productos variables revisados');
  });

  rows.sort((a, b) => a.categoria.localeCompare(b.categoria, 'es') || String(a.padre || a.sku).localeCompare(String(b.padre || b.sku)) || String(a.sku).localeCompare(String(b.sku)));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sin fotos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Nombre', key: 'nombre', width: 48 },
    { header: 'Inventario', key: 'inventario', width: 11 },
    { header: 'Estado', key: 'estado', width: 13 },
    { header: 'Tipo', key: 'tipo', width: 22 },
    { header: 'SKU padre', key: 'padre', width: 14 },
    { header: 'Categoría', key: 'categoria', width: 28 },
    { header: '¿Fotos en Medios?', key: 'medios', width: 18 },
  ];
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  ws.autoFilter = { from: 'A1', to: `H${rows.length + 1}` };

  const count = (f) => rows.filter(f).length;
  return {
    buffer: await wb.xlsx.writeBuffer(),
    summary: {
      'Sin foto (total)': rows.length,
      'Productos simples': count((r) => r.tipo === 'Simple'),
      Variaciones: count((r) => r.tipo === 'Variación'),
      'Productos variables': count((r) => r.tipo.startsWith('Variable')),
      Publicados: count((r) => r.estado === 'Publicado'),
      'Con inventario': count((r) => r.inventario > 0),
      'Con fotos en Medios (Revisar fotos las asigna)': count((r) => r.medios !== 'No' && r.tipo !== 'Variable' && !r.tipo.startsWith('Variable')),
    },
  };
}

module.exports = { buildNoPhotosReport, inMedia };
