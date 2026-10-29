// Operaciones de la tienda que usa el push: lecturas puntuales (solo de lo que
// cambió) y escrituras por lotes.
const config = require('../config');
const { getApi } = require('./client');
const throttle = require('./throttle');

const BATCH_SIZE = Number(process.env.WOO_BATCH_SIZE) || 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El 429 lo maneja throttle (pausa y repite: el hosting rechazó la petición sin
// procesarla). Los demás errores pasajeros se reintentan aquí, solo para
// lecturas y escrituras idempotentes.
async function request(method, endpoint, data, params, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const api = getApi();
      const res = await throttle.axiosCall(() => (method === 'get' ? api.get(endpoint, data) : api[method](endpoint, data, params)));
      return res;
    } catch (error) {
      const status = error.response?.status;
      const transient = !status || status >= 500;
      if (!transient || attempt >= attempts) {
        const detail = error.response?.data?.message;
        if (detail) error.message = `${error.message} — ${detail}`;
        throw error;
      }
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

async function getAll(endpoint, params = {}) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const res = await request('get', endpoint, { per_page: 100, ...params, page });
    all.push(...res.data);
    if (page >= Number(res.headers['x-wp-totalpages'] || 1)) return all;
  }
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const lang = () => ({ lang: config.woo.lang });

// Catálogos auxiliares para traducir nombres del Excel a IDs de Woo.
async function fetchTaxonomies() {
  const [categories, tags, attributes, brands] = await Promise.all([
    getAll('products/categories', lang()),
    getAll('products/tags', lang()),
    getAll('products/attributes'),
    getAll('products/brands', lang()).catch(() => null), // Woo < 9.6 no tiene marcas
  ]);
  return { categories, tags, attributes, brands };
}

async function fetchProductsByIds(ids) {
  const out = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    out.push(...await getAll('products', { include: part.join(','), status: 'any', context: 'edit', ...lang() }));
  }
  return out;
}

async function fetchVariationsByIds(parentId, ids) {
  return getAll(`products/${parentId}/variations`, { include: ids.join(','), context: 'edit', ...lang() });
}

// Productos (no variaciones) cuyo SKU está en la lista; para detectar altas que ya existen.
async function fetchProductsBySkus(skus) {
  const out = [];
  for (const part of chunk([...new Set(skus)], 50)) {
    out.push(...await getAll('products', { sku: part.join(','), status: 'any', context: 'edit', ...lang() }));
    // "any" no incluye la papelera, pero un producto en la papelera sigue reservando su SKU.
    out.push(...await getAll('products', { sku: part.join(','), status: 'trash', context: 'edit', ...lang() }));
  }
  return out;
}

// allLanguages: también las variaciones de una traducción (WPML filtra por idioma).
async function fetchAllVariations(parentId, { allLanguages = false } = {}) {
  return getAll(`products/${parentId}/variations`, { context: 'edit', ...(allLanguages ? { lang: 'all' } : lang()) });
}

// Productos por ID en cualquier idioma (las traducciones de WPML tienen otro ID).
async function fetchProductsAllLanguages(ids) {
  const out = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    out.push(...await getAll('products', { include: part.join(','), status: 'any', context: 'edit', lang: 'all' }));
  }
  return out;
}

// Todos los productos (sin variaciones) con solo los campos del tablero de fotos y del reporte de variantes sueltas.
async function fetchProductsLite() {
  return getAll('products', { status: 'any', _fields: 'id,sku,name,type,status,images,categories,permalink', ...lang() });
}

// Productos variables con lo necesario para revisar sus atributos.
async function fetchVariableProducts() {
  return getAll('products', { type: 'variable', status: 'any', context: 'edit', _fields: 'id,sku,name,status,attributes,variations,permalink', ...lang() });
}

async function createTerm(taxonomyEndpoint, data) {
  const res = await request('post', taxonomyEndpoint, data);
  return res.data;
}

/**
 * Envía { create: [], update: [] } en lotes. Devuelve los resultados en el mismo
 * orden que las entradas: { ok, data | error }. Las escrituras no se reintentan
 * para no duplicar productos si la tienda sí alcanzó a guardarlos.
 */
async function batch(endpoint, { create = [], update = [] }, onBatch = () => {}) {
  const results = { create: [], update: [] };
  const jobs = [
    ...chunk(create, BATCH_SIZE).map((items) => ({ op: 'create', items })),
    ...chunk(update, BATCH_SIZE).map((items) => ({ op: 'update', items })),
  ];
  for (const job of jobs) {
    let responses;
    try {
      const res = await request('post', `${endpoint}/batch`, { [job.op]: job.items }, undefined, 1);
      responses = res.data[job.op] || [];
    } catch (error) {
      responses = job.items.map(() => ({ error: { message: error.message } }));
    }
    job.items.forEach((_, i) => {
      const r = responses[i];
      results[job.op].push(r && !r.error ? { ok: true, data: r } : { ok: false, error: r?.error?.message || 'Sin respuesta de la tienda' });
    });
    onBatch(job.items.length);
  }
  return results;
}

module.exports = {
  request, fetchTaxonomies, fetchProductsByIds, fetchVariationsByIds, fetchProductsBySkus, fetchAllVariations, fetchProductsAllLanguages, fetchProductsLite, fetchVariableProducts, createTerm, batch,
};
