const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const config = require('../config');
const throttle = require('./throttle');
const { httpsAgent } = require('./http');

let api;
function getApi() {
  api ??= new WooCommerceRestApi({
    url: config.woo.url(),
    consumerKey: config.woo.key(),
    consumerSecret: config.woo.secret(),
    version: 'wc/v3',
    queryStringAuth: true,
    axiosConfig: { httpsAgent },
  });
  return api;
}

// Reintenta errores pasajeros (502/503/504, red caída) con espera creciente; el 429 lo maneja throttle.
async function get(endpoint, params, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await throttle.axiosCall(() => getApi().get(endpoint, params));
    } catch (error) {
      const status = error.response?.status;
      const transient = !status || status >= 500;
      if (!transient || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}

async function getAllPages(endpoint, params = {}) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const res = await get(endpoint, { per_page: 100, ...params, page });
    all.push(...res.data);
    if (page >= Number(res.headers['x-wp-totalpages'] || 1)) return all;
  }
}

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

// Todos los productos del idioma principal (sin papelera) con sus variaciones,
// más el árbol de categorías para poder escribir rutas "PADRE > HIJA".
async function fetchCatalog({ onProgress } = {}) {
  // context=edit: valores reales guardados. En modo "view" Woo rellena, por
  // ejemplo, el SKU vacío de una variación con el SKU del padre.
  const categories = await getAllPages('products/categories', { lang: config.woo.lang });
  const products = await getAllPages('products', { status: 'any', lang: config.woo.lang, context: 'edit' });
  const variable = products.filter((p) => p.type === 'variable');
  let done = 0;

  await withConcurrency(variable, config.woo.concurrency, async (product) => {
    product.variations_data = await getAllPages(`products/${product.id}/variations`, { lang: config.woo.lang, context: 'edit' });
    onProgress?.(++done, variable.length);
  });

  return { products, categories };
}

module.exports = { getApi, fetchCatalog };
