const path = require('path');

function baseNameWithoutExt(filename) {
  return path.basename(filename, path.extname(filename));
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getSkuCandidateFromFilename(filename) {
  const base = baseNameWithoutExt(filename);
  return base.replace(/_\d+$/, '');
}

function groupImages(files = []) {
  const groups = new Map();

  files.forEach((file) => {
    const key = normalizeKey(getSkuCandidateFromFilename(file.originalname));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      originalName: file.originalname,
      filename: file.filename,
      path: file.path,
      url: `/uploads/${file.filename}`,
      source: 'upload',
    });
  });

  for (const images of groups.values()) {
    images.sort((a, b) => {
      const aMain = !/_\d+\.[^.]+$/i.test(a.originalName);
      const bMain = !/_\d+\.[^.]+$/i.test(b.originalName);
      if (aMain && !bMain) return -1;
      if (!aMain && bMain) return 1;
      return a.originalName.localeCompare(b.originalName, undefined, { numeric: true });
    });
  }

  return groups;
}

function attachUploadedImages(products, files = []) {
  const groups = groupImages(files);

  return products.map((product) => {
    const candidates = [product.sku, product.genericSku, product.parentSku]
      .map(normalizeKey)
      .filter(Boolean);

    const matched = candidates.flatMap((candidate) => groups.get(candidate) || []);
    if (!matched.length) return product;

    return {
      ...product,
      images: matched,
      imageMatch: 'uploaded_files',
    };
  });
}

module.exports = { attachUploadedImages, groupImages };
