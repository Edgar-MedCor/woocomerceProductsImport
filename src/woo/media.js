// Sube archivos a la biblioteca de medios de WordPress. Las llaves de
// WooCommerce no lo permiten: se usa una contraseña de aplicación de WordPress.
const axios = require('axios');
const config = require('../config');
const throttle = require('./throttle');
const { httpsAgent } = require('./http');

function authHeader() {
  const token = Buffer.from(`${config.wp.user()}:${config.wp.appPassword().replace(/\s+/g, '')}`).toString('base64');
  return `Basic ${token}`;
}

async function uploadMedia({ buffer, filename, mime, title }) {
  const url = `${config.woo.url().replace(/\/$/, '')}/wp-json/wp/v2/media`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Texto alternativo y título = nombre del producto (accesibilidad y SEO). Van en
      // la misma subida (WordPress los toma de los parámetros) para no gastar otra petición.
      const { data: media } = await throttle.axiosCall(() => axios.post(url, buffer, {
        params: title ? { alt_text: title, title } : undefined,
        headers: {
          Authorization: authHeader(),
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        },
        httpsAgent,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
      }));
      return { id: media.id, url: media.source_url };
    } catch (error) {
      const status = error.response?.status;
      // El 429 ya lo esperó throttle. Los 5xx se reintentan como antes.
      if (status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      const data = error.response?.data;
      let message = (typeof data === 'object' && data?.message) || (typeof data === 'string' ? data.slice(0, 300) : '') || error.message;
      if (status === 401) message = 'WordPress rechazó el usuario o la contraseña de aplicación (WP_USER / WP_APP_PASSWORD).';
      throw new Error(`No se pudo subir la foto a WordPress (${status || 'sin respuesta'}): ${message}`);
    }
  }
}

// ¿Sigue existiendo la imagen en la Biblioteca de medios? (alguien pudo borrarla)
async function mediaExists(id) {
  const url = `${config.woo.url().replace(/\/$/, '')}/wp-json/wp/v2/media/${id}`;
  try {
    await throttle.axiosCall(() => axios.get(url, { params: { context: 'edit', _fields: 'id' }, headers: { Authorization: authHeader() }, httpsAgent, timeout: 60000 }));
    return true;
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 410) return false;
    throw error;
  }
}

// --- Índice de la Biblioteca de medios por nombre de archivo ---
// Las fotos se nombran SKU-1, SKU-2… (o estilo+color-1 para todas las tallas de un
// color). El título no sirve para buscar (el panel pone el nombre del producto),
// así que se lee la lista completa una vez y luego solo las imágenes nuevas.

// "RC49206004-1.webp" -> { code: 'RC49206004', n: 1 }. WordPress agrega "-1", "-2"…
// a los nombres repetidos ("RD49339035-1-1.webp") y "-scaled" a las fotos grandes.
function parseMediaName(url) {
  const file = decodeURIComponent(String(url || '').split('/').pop() || '');
  const ext = (file.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const base = file.replace(/\.[a-z0-9]+$/i, '').replace(/-scaled$/i, '');
  const m = base.match(/^([A-Za-z0-9]+)-(\d{1,2})(?:-\d+)?$/);
  return m ? { code: m[1].toUpperCase(), n: Number(m[2]), ext } : null;
}

const mediaIndex = { byCode: new Map(), maxId: 0 };

function addToIndex(item) {
  const parsed = parseMediaName(item.source_url);
  if (!parsed) return;
  const byN = mediaIndex.byCode.get(parsed.code) || new Map();
  byN.set(parsed.n, [...(byN.get(parsed.n) || []), { id: item.id, url: item.source_url, ext: parsed.ext }]);
  mediaIndex.byCode.set(parsed.code, byN);
}

// Lee de la más nueva a la más vieja y se detiene al llegar a las que ya conoce.
async function refreshMediaIndex({ onProgress = () => {} } = {}) {
  const url = `${config.woo.url().replace(/\/$/, '')}/wp-json/wp/v2/media`;
  const known = mediaIndex.maxId;
  let newest = known;
  let read = 0;
  for (let page = 1; ; page += 1) {
    const { data, headers } = await throttle.axiosCall(() => axios.get(url, {
      params: { per_page: 100, page, orderby: 'id', order: 'desc', media_type: 'image', _fields: 'id,source_url' },
      headers: { Authorization: authHeader() },
      httpsAgent,
      timeout: 120000,
    }));
    const fresh = data.filter((m) => m.id > known);
    fresh.forEach(addToIndex);
    read += fresh.length;
    if (data.length) newest = Math.max(newest, data[0].id);
    onProgress(read, known ? null : Number(headers['x-wp-total']) || null);
    if (fresh.length < data.length || page >= Number(headers['x-wp-totalpages'] || 1)) break;
  }
  mediaIndex.maxId = newest;
  return read;
}

// Fotos de un código (SKU o estilo+color), una por número y en orden. Si hay
// varias copias del mismo número se usa la .webp más reciente.
function mediaFor(code) {
  const byN = mediaIndex.byCode.get(String(code || '').trim().toUpperCase());
  if (!byN) return [];
  return [...byN.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, copies]) => {
      const best = [...copies].sort((a, b) => (b.ext === 'webp') - (a.ext === 'webp') || b.id - a.id)[0];
      return { n, id: best.id, url: best.url };
    });
}

module.exports = { uploadMedia, mediaExists, parseMediaName, refreshMediaIndex, mediaFor, _mediaIndex: mediaIndex, _addToIndex: addToIndex };
