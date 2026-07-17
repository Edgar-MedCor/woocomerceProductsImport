const { slugify, cleanText } = require('../utils/normalizer');
const { getAllPages } = require('./wooClient');

function unique(values = []) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function categoryParts(path) {
  return cleanText(path)
    .split('>')
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function collectCategoryPaths(products) {
  return unique(products.flatMap((product) => product.categories || []));
}

function collectTags(products) {
  return unique(products.flatMap((product) => product.tags || []));
}

function collectAttributes(products) {
  const map = new Map();

  products.forEach((product) => {
    (product.attributes || []).forEach((attr) => {
      const name = cleanText(attr.name);
      if (!name) return;
      if (name.toLowerCase().includes('sku generico')) return;
      if (!map.has(name)) map.set(name, new Set());
      (attr.values || []).forEach((value) => {
        const clean = cleanText(value);
        if (clean) map.get(name).add(clean);
      });
    });
  });

  return [...map.entries()].map(([name, terms]) => ({ name, terms: [...terms].sort() }));
}

function bySlug(items) {
  const map = new Map();
  items.forEach((item) => map.set(item.slug || slugify(item.name), item));
  return map;
}

async function ensureCategories(api, products, { createMissing = false } = {}) {
  const existing = await getAllPages(api, 'products/categories', { hide_empty: false });
  const slugMap = bySlug(existing);
  const pathMap = {};
  const missing = [];
  const created = [];

  for (const path of collectCategoryPaths(products)) {
    let parent = 0;
    let currentPath = '';

    for (const part of categoryParts(path)) {
      currentPath = currentPath ? `${currentPath} > ${part}` : part;
      const slug = slugify(part);
      let category = [...slugMap.values()].find((item) => item.slug === slug && Number(item.parent || 0) === Number(parent));

      if (!category) {
        missing.push({ name: part, path: currentPath, parent });
        if (!createMissing) continue;
        const res = await api.post('products/categories', { name: part, slug, parent });
        category = res.data;
        slugMap.set(category.slug, category);
        created.push({ id: category.id, name: category.name, path: currentPath });
      }

      if (category) {
        parent = category.id;
        pathMap[currentPath] = category.id;
      }
    }
  }

  return { map: pathMap, missing, created };
}

async function ensureTags(api, products, { createMissing = false } = {}) {
  const existing = await getAllPages(api, 'products/tags', { hide_empty: false });
  const slugMap = bySlug(existing);
  const map = {};
  const missing = [];
  const created = [];

  for (const name of collectTags(products)) {
    const slug = slugify(name);
    let tag = slugMap.get(slug);
    if (!tag) {
      missing.push({ name });
      if (!createMissing) continue;
      const res = await api.post('products/tags', { name, slug });
      tag = res.data;
      slugMap.set(tag.slug, tag);
      created.push({ id: tag.id, name: tag.name });
    }
    if (tag) map[name] = tag.id;
  }

  return { map, missing, created };
}

async function ensureAttributesAndTerms(api, products, { createMissing = false } = {}) {
  let attributes = await getAllPages(api, 'products/attributes');
  const attrByName = new Map(attributes.map((attr) => [cleanText(attr.name).toLowerCase(), attr]));
  const map = {};
  const termMap = {};
  const missingAttributes = [];
  const createdAttributes = [];
  const missingTerms = [];
  const createdTerms = [];

  for (const attr of collectAttributes(products)) {
    const key = attr.name.toLowerCase();
    let wooAttr = attrByName.get(key);

    if (!wooAttr) {
      missingAttributes.push({ name: attr.name });
      if (!createMissing) continue;
      const res = await api.post('products/attributes', {
        name: attr.name,
        slug: slugify(attr.name).slice(0, 28),
        type: 'select',
        order_by: 'menu_order',
        has_archives: false,
      });
      wooAttr = res.data;
      attrByName.set(key, wooAttr);
      createdAttributes.push({ id: wooAttr.id, name: wooAttr.name });
    }

    if (!wooAttr) continue;

    map[attr.name] = wooAttr.id;
    termMap[attr.name] = {};

    const terms = await getAllPages(api, `products/attributes/${wooAttr.id}/terms`, { hide_empty: false });
    const termsBySlug = bySlug(terms);

    for (const termName of attr.terms) {
      const slug = slugify(termName);
      let term = termsBySlug.get(slug);
      if (!term) {
        missingTerms.push({ attribute: attr.name, term: termName });
        if (!createMissing) continue;
        const res = await api.post(`products/attributes/${wooAttr.id}/terms`, { name: termName, slug });
        term = res.data;
        termsBySlug.set(term.slug, term);
        createdTerms.push({ attribute: attr.name, id: term.id, name: term.name });
      }
      if (term) termMap[attr.name][termName] = term.id;
    }
  }

  return { map, termMap, missingAttributes, createdAttributes, missingTerms, createdTerms };
}

async function prepareStore(api, products, options = {}) {
  const categoryResult = await ensureCategories(api, products, options);
  const tagResult = await ensureTags(api, products, options);
  const attributeResult = await ensureAttributesAndTerms(api, products, options);

  return {
    categoryMap: categoryResult.map,
    tagMap: tagResult.map,
    attributeMap: attributeResult.map,
    termMap: attributeResult.termMap,
    missing: {
      categories: categoryResult.missing,
      tags: tagResult.missing,
      attributes: attributeResult.missingAttributes,
      terms: attributeResult.missingTerms,
    },
    created: {
      categories: categoryResult.created,
      tags: tagResult.created,
      attributes: attributeResult.createdAttributes,
      terms: attributeResult.createdTerms,
    },
  };
}

module.exports = {
  prepareStore,
  collectCategoryPaths,
  collectTags,
  collectAttributes,
};
