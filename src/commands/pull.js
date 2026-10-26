const fs = require('fs');
const path = require('path');
const config = require('../config');
const state = require('../state');
const onedrive = require('../storage/onedrive');
const { fetchCatalog } = require('../woo/client');
const { catalogToRows, TYPE } = require('../excel/layout');
const { buildWorkbook } = require('../excel/writer');

// Copia del último catálogo descargado, para regenerar el Excel sin volver a
// consultar la tienda (útil en pruebas: la tienda local tarda mucho).
const CACHE_FILE = path.join(config.STATE_DIR, 'catalog-cache.json');

// Error esperado cuando el Excel tiene cambios posteriores al último pull.
class ExcelModifiedError extends Error {
  constructor(info) {
    const who = info.lastModifiedBy?.user?.displayName || 'alguien';
    super(
      `El Excel en OneDrive cambió después del último pull (lo modificó ${who} el ` +
      `${new Date(info.lastModifiedDateTime).toLocaleString('es-MX')}). Puede tener cambios que aún no ` +
      'se suben a la tienda; si haces pull se perderían. OneDrive guarda la versión anterior en su historial.',
    );
    this.code = 'EXCEL_MODIFIED';
  }
}

async function loadCatalog(useCache, { log, onProgress }) {
  if (useCache) {
    if (!fs.existsSync(CACHE_FILE)) throw new Error('No hay catálogo en caché; ejecuta un pull sin --cache primero.');
    log(`Usando catálogo en caché (${CACHE_FILE})`);
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
  log(`Leyendo productos de ${config.woo.url()} (idioma: ${config.woo.lang})...`);
  const catalog = await fetchCatalog({ onProgress });
  fs.mkdirSync(config.STATE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog));
  return catalog;
}

/**
 * Trae el catálogo de WooCommerce y lo escribe en el Excel (OneDrive o local).
 * Devuelve { summary, webUrl }. `log` y `onProgress` permiten mostrar el avance
 * en la terminal o en el panel.
 */
async function pull({ force = false, local = null, cache = false, log = console.log, onProgress = () => {} } = {}) {
  const excelPath = config.excelPath();

  // 1. No pisar un Excel que el equipo editó después del último pull.
  if (!local) {
    const info = await onedrive.getFileInfo(excelPath);
    const last = state.get(excelPath);
    if (info && info.eTag !== last?.eTag && !force) throw new ExcelModifiedError(info);
  }

  // 2. Traer catálogo de WooCommerce y construir el Excel.
  const catalog = await loadCatalog(cache, { log, onProgress });
  const rows = catalogToRows(catalog);
  const meta = {
    source: config.woo.url(),
    lang: config.woo.lang,
    pulledAt: new Date().toLocaleString('es-MX'),
    formatVersion: 2,
  };
  log('Generando el Excel...');
  const buffer = await buildWorkbook(rows, meta);

  const products = rows.filter((r) => r.type !== TYPE.variation);
  const summary = {
    'Productos simples': rows.filter((r) => r.type === TYPE.simple).length,
    'Productos variables': rows.filter((r) => r.type === TYPE.variable).length,
    '  …de ellos SIN variaciones': rows.filter((r) => r._variationCount === 0).length,
    Variaciones: rows.filter((r) => r.type === TYPE.variation).length,
    'Filas sin SKU': rows.filter((r) => !r.sku).length,
    'Productos sin categoría': products.filter((r) => !r.categories).length,
  };

  // 3. Guardar en OneDrive (o local, para pruebas).
  let webUrl = null;
  if (local) {
    fs.mkdirSync(path.dirname(path.resolve(local)), { recursive: true });
    fs.writeFileSync(local, buffer);
    log(`Excel guardado localmente en ${path.resolve(local)}`);
  } else {
    log('Subiendo el Excel a OneDrive...');
    const uploaded = await onedrive.uploadFile(excelPath, buffer);
    webUrl = uploaded.webUrl;
    state.set(excelPath, { eTag: uploaded.eTag, pulledAt: meta.pulledAt, source: meta.source, webUrl });
    log(`Excel subido a OneDrive: ${webUrl}`);
  }
  return { summary, webUrl };
}

module.exports = pull;
module.exports.ExcelModifiedError = ExcelModifiedError;
