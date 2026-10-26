// Prepara una foto para la web: corrige la orientación (fotos de celular),
// limita el lado mayor y la comprime. Las fotos de celular pesan 5-10 MB y
// harían lenta la tienda.
const sharp = require('sharp');
const config = require('../config');

const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const READY_MAX_BYTES = 1.5 * 1024 * 1024;

async function prepareImage(buffer, originalName, baseName) {
  const extension = (originalName.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  if (extension === '.gif') return { buffer, filename: `${baseName}.gif`, mime: 'image/gif' }; // puede ser animado

  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const meta = await image.metadata();

  // Fotos ya preparadas por el equipo (tamaño y peso correctos, sin rotación
  // pendiente): se suben tal cual para no perder calidad recomprimiendo.
  const ready = MIME[extension]
    && Math.max(meta.width || 0, meta.height || 0) <= config.photos.maxSide
    && (!meta.orientation || meta.orientation === 1)
    && buffer.length <= READY_MAX_BYTES;
  if (ready) return { buffer, filename: `${baseName}${extension === '.jpeg' ? '.jpg' : extension}`, mime: MIME[extension] };
  const resized = image.resize({ width: config.photos.maxSide, height: config.photos.maxSide, fit: 'inside', withoutEnlargement: true });

  if (extension === '.webp') {
    return { buffer: await resized.webp({ quality: 85 }).toBuffer(), filename: `${baseName}.webp`, mime: 'image/webp' };
  }
  if (extension === '.png' && meta.hasAlpha) {
    return { buffer: await resized.png({ compressionLevel: 9 }).toBuffer(), filename: `${baseName}.png`, mime: 'image/png' };
  }
  return { buffer: await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), filename: `${baseName}.jpg`, mime: 'image/jpeg' };
}

module.exports = { prepareImage };
