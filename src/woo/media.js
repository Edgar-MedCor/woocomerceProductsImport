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

module.exports = { uploadMedia, mediaExists };
