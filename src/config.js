const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// La sesión de Microsoft y el estado local se guardan FUERA de la carpeta del
// proyecto, porque el proyecto vive dentro de OneDrive y se sincronizaría a la nube.
const STATE_DIR = path.join(os.homedir(), '.wayan-sync');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en .env (ver .env.example)`);
  return value;
}

module.exports = {
  STATE_DIR,
  woo: {
    url: () => required('WOO_URL'),
    key: () => required('WOO_KEY'),
    secret: () => required('WOO_SECRET'),
    lang: process.env.WOO_LANG || 'es',
    concurrency: Number(process.env.WOO_CONCURRENCY) || 5,
    // IP del servidor real de la tienda, para no pasar por el CDN (ver woo/http.js).
    originIp: (process.env.WOO_ORIGIN_IP || '').trim(),
  },
  ms: {
    clientId: () => required('MS_CLIENT_ID'),
    authority: `https://login.microsoftonline.com/${process.env.MS_AUTHORITY || 'consumers'}`,
    // En SharePoint (carpeta de un sitio del equipo) se necesita acceso a los
    // archivos que el usuario puede ver, no solo a los suyos.
    scopes: [process.env.ONEDRIVE_ROOT_URL ? 'Files.ReadWrite.All' : 'Files.ReadWrite', 'User.Read', 'offline_access'],
  },
  // Vínculo de la carpeta raíz en SharePoint/OneDrive ("Copiar vínculo"). Vacío = OneDrive de la cuenta conectada.
  // Las rutas del Excel y de las fotos son relativas a esta carpeta.
  storageRootUrl: process.env.ONEDRIVE_ROOT_URL || '',
  excelPath: () => required('ONEDRIVE_EXCEL_PATH'),
  wp: {
    user: () => required('WP_USER'),
    appPassword: () => required('WP_APP_PASSWORD'),
  },
  photos: {
    pendingPath: process.env.PHOTOS_PENDING_PATH || '4.Sitio Web/Falta subir',
    donePath: process.env.PHOTOS_DONE_PATH || '4.Sitio Web/Subidas',
    mode: process.env.PHOTOS_MODE === 'append' ? 'append' : 'replace',
    // Cambio de prefijo de las carpetas al moverlas a "subidas": "F.S. =>S. "
    // convierte "F.S. Ropa Dama" en "S. Ropa Dama". Varias reglas separadas por ";".
    doneRename: (process.env.PHOTOS_DONE_RENAME ?? 'F.S. =>S. ').split(';').map((rule) => rule.split('=>')).filter((r) => r.length === 2 && r[0]),
    maxSide: Number(process.env.PHOTOS_MAX_SIDE) || 2000,
    maxSkusPerRun: Number(process.env.PHOTOS_MAX_SKUS) || 300,
    concurrency: Number(process.env.PHOTOS_CONCURRENCY) || 3,
  },
};
