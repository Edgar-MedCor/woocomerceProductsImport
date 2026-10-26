// Tablero de fotos: qué está pendiente en OneDrive, qué productos de la tienda
// no tienen fotos y qué se subió últimamente. Solo lee; no modifica nada.
const config = require('../config');
const store = require('../woo/store');
const { reviewPhotos } = require('../commands/photos');

const STATUS = { publish: 'Publicado', draft: 'Borrador', pending: 'En revisión', private: 'Privado' };
const cleanFolder = (name) => name.replace(/^F\.S\.\s*/i, '').trim();

async function buildDashboard(pool, { log = () => {} } = {}) {
  // 1. Carpetas pendientes (misma revisión que el botón "Revisar fotos").
  let review = null;
  let pendingError = null;
  try {
    review = await reviewPhotos({ log });
  } catch (error) {
    pendingError = error.message;
  }
  const items = review?.items || [];
  const ready = items.filter((i) => !i.errors.length);
  const byCategory = new Map();
  for (const i of items) {
    const top = cleanFolder(i.path.split('/')[0] || '(raíz)');
    const entry = byCategory.get(top) || { categoria: top, carpetas: 0, fotos: 0, bloqueadas: 0 };
    entry.carpetas += 1;
    entry.fotos += i.files.length;
    if (i.errors.length) entry.bloqueadas += 1;
    byCategory.set(top, entry);
  }
  const pendingSkus = new Set(items.map((i) => String(i.target.sku).toUpperCase()));

  // 2. Productos de la tienda sin ninguna foto.
  log('Consultando qué productos de la tienda no tienen fotos...');
  const products = await store.fetchProductsLite();
  const noPhotos = products
    .filter((p) => !(p.images || []).length)
    .map((p) => ({
      sku: p.sku || '(sin SKU)',
      name: p.name,
      type: p.type === 'variable' ? 'Variable' : 'Simple',
      status: STATUS[p.status] || p.status,
      categoria: (p.categories || []).map((c) => c.name).join(', ') || '—',
      pendienteEnCarpeta: pendingSkus.has(String(p.sku).toUpperCase()),
    }))
    .sort((a, b) => a.categoria.localeCompare(b.categoria, 'es') || a.name.localeCompare(b.name, 'es'));

  // 3. Fotos subidas (registro del panel).
  const { rows: totals } = await pool.query(`
    SELECT count(*) FILTER (WHERE uploaded_at > now() - interval '7 days')::int AS d7,
           count(*) FILTER (WHERE uploaded_at > now() - interval '30 days')::int AS d30,
           count(*)::int AS total
    FROM photo_uploads`);
  const { rows: recent } = await pool.query(`
    SELECT pu.sku, count(*)::int AS fotos, max(pu.uploaded_at) AS fecha, max(u.display_name) AS usuario
    FROM photo_uploads pu
    LEFT JOIN sync_runs r ON r.id = pu.run_id
    LEFT JOIN users u ON u.id = r.user_id
    GROUP BY pu.sku ORDER BY max(pu.uploaded_at) DESC LIMIT 50`);

  return {
    updatedAt: new Date().toISOString(),
    folders: { pending: config.photos.pendingPath, done: config.photos.donePath },
    pending: {
      error: pendingError,
      listos: ready.filter((i) => !i.deferred).length,
      fotos: ready.reduce((n, i) => n + i.files.length, 0),
      bloqueados: items.length - ready.length,
      porCategoria: [...byCategory.values()].sort((a, b) => b.carpetas - a.carpetas),
      items: items.map((i) => ({
        path: i.path,
        sku: i.label,
        name: i.name,
        fotos: i.files.length,
        estado: i.errors.length ? `Bloqueado: ${i.errors.join(' ')}` : i.deferred ? 'Siguiente tanda' : 'Listo para subir',
        ok: !i.errors.length,
      })),
    },
    avisos: review?.warnings || [],
    sinFotos: {
      total: noPhotos.length,
      publicados: noPhotos.filter((p) => p.status === 'Publicado').length,
      conCarpetaPendiente: noPhotos.filter((p) => p.pendienteEnCarpeta).length,
      items: noPhotos,
    },
    subidas: { ...totals[0], recientes: recent },
  };
}

// Se calcula en segundo plano y se guarda el último resultado (consultar la
// tienda y OneDrive puede tardar); no bloquea las sincronizaciones.
let cache = null;
let running = null;

function getDashboard() {
  return { dashboard: cache, refreshing: Boolean(running) };
}

function refreshDashboard(pool) {
  if (!running) {
    running = buildDashboard(pool)
      .then((d) => { cache = d; })
      .catch((error) => { cache = { ...(cache || {}), error: error.message, updatedAt: new Date().toISOString() }; })
      .finally(() => { running = null; });
  }
  return running;
}

module.exports = { getDashboard, refreshDashboard, buildDashboard };
