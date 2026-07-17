const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;

function createWooClient() {
  if (!process.env.WOO_URL || !process.env.WOO_KEY || !process.env.WOO_SECRET) {
    throw new Error('Faltan WOO_URL, WOO_KEY o WOO_SECRET en .env');
  }

  return new WooCommerceRestApi({
    url: process.env.WOO_URL,
    consumerKey: process.env.WOO_KEY,
    consumerSecret: process.env.WOO_SECRET,
    version: 'wc/v3',
    queryStringAuth: true,
  });
}

async function findProductBySku(api, sku) {
  if (!sku) return null;
  const res = await api.get('products', { sku, per_page: 10 });
  return res.data?.[0] || null;
}

async function findVariationBySku(api, parentProductId, sku) {
  if (!parentProductId || !sku) return null;
  const res = await api.get(`products/${parentProductId}/variations`, { sku, per_page: 10 });
  return res.data?.[0] || null;
}

async function getAllPages(api, endpoint, params = {}) {
  const all = [];
  let page = 1;
  const perPage = params.per_page || 100;

  while (true) {
    const res = await api.get(endpoint, { ...params, page, per_page: perPage });
    const data = Array.isArray(res.data) ? res.data : [];
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
    if (page > 100) break;
  }

  return all;
}

async function withConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = {
  createWooClient,
  findProductBySku,
  findVariationBySku,
  getAllPages,
  withConcurrency,
};
