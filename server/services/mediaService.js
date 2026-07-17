const fs = require('fs');
const path = require('path');
const axios = require('axios');

function getMimeType(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
  };
  return types[ext] || 'application/octet-stream';
}

function isRemoteImage(image = {}) {
  const src = image.src || image.remoteUrl || image.url;
  return /^https?:\/\//i.test(src || '');
}

function isUploadedImage(image = {}) {
  return image.source === 'upload' || Boolean(image.path || image.filename);
}

function getMediaCredentials() {
  const baseUrl = String(process.env.WOO_URL || '').replace(/\/$/, '');
  const user = process.env.WP_USER;
  const password = process.env.WP_APP_PASSWORD;

  if (!baseUrl) throw new Error('Falta WOO_URL en .env');
  if (!user) throw new Error('Falta WP_USER en .env para subir imágenes locales');
  if (!password) throw new Error('Falta WP_APP_PASSWORD en .env para subir imágenes locales');

  return { baseUrl, user, password };
}

async function uploadImageToWordPress(image = {}, cache = new Map()) {
  if (isRemoteImage(image)) {
    return { src: image.src || image.remoteUrl || image.url };
  }

  if (!isUploadedImage(image)) return null;

  const filePath = image.path;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`No se encontró el archivo local para subir: ${image.originalName || image.filename || 'imagen sin nombre'}`);
  }

  const cacheKey = filePath;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const { baseUrl, user, password } = getMediaCredentials();
  const endpoint = `${baseUrl}/wp-json/wp/v2/media`;
  const filename = image.originalName || path.basename(filePath);
  const token = Buffer.from(`${user}:${password}`).toString('base64');

  const response = await axios.post(endpoint, fs.createReadStream(filePath), {
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Type': getMimeType(filePath),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const uploaded = {
    id: response.data.id,
    src: response.data.source_url,
    name: filename,
  };

  cache.set(cacheKey, uploaded);
  return uploaded;
}

async function resolveImagesForProduct(product = {}, cache = new Map()) {
  const images = product.images || [];
  const resolvedImages = [];

  for (const image of images) {
    const resolved = await uploadImageToWordPress(image, cache);
    if (resolved) resolvedImages.push(resolved);
  }

  return {
    ...product,
    images: resolvedImages,
  };
}

async function resolveImagesForProducts(products = []) {
  const cache = new Map();
  const resolved = [];

  for (const product of products) {
    if (product.type === 'variation') {
      resolved.push(product);
      continue;
    }
    resolved.push(await resolveImagesForProduct(product, cache));
  }

  return resolved;
}

module.exports = {
  isRemoteImage,
  isUploadedImage,
  uploadImageToWordPress,
  resolveImagesForProduct,
  resolveImagesForProducts,
};
