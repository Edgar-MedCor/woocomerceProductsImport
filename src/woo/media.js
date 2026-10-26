// Sube archivos a la biblioteca de medios de WordPress. Las llaves de
// WooCommerce no lo permiten: se usa una contraseña de aplicación de WordPress.
const config = require('../config');

function authHeader() {
  const token = Buffer.from(`${config.wp.user()}:${config.wp.appPassword().replace(/\s+/g, '')}`).toString('base64');
  return `Basic ${token}`;
}

async function uploadMedia({ buffer, filename, mime, title }) {
  const url = `${config.woo.url().replace(/\/$/, '')}/wp-json/wp/v2/media`;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
      body: buffer,
    });
    if (res.ok) {
      const media = await res.json();
      if (title) {
        // Texto alternativo = nombre del producto (accesibilidad y SEO). Si falla no es grave.
        await fetch(`${url}/${media.id}`, {
          method: 'POST',
          headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ alt_text: title, title }),
        }).catch(() => {});
      }
      return { id: media.id, url: media.source_url };
    }
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < 3) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    const body = await res.text();
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).message || message; } catch { /* respuesta no JSON */ }
    if (res.status === 401) message = 'WordPress rechazó el usuario o la contraseña de aplicación (WP_USER / WP_APP_PASSWORD).';
    throw new Error(`No se pudo subir la foto a WordPress (${res.status}): ${message}`);
  }
}

module.exports = { uploadMedia };
