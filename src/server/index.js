require('../config'); // carga .env
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, migrate } = require('./db');
const { loadUser, requireAuth, requirePermission } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// En el VPS solo escucha localmente: el acceso público entra por nginx (HTTPS).
const HOST = process.env.HOST || (IS_PROD ? '127.0.0.1' : '0.0.0.0');

if (IS_PROD && !process.env.SESSION_SECRET) throw new Error('Falta SESSION_SECRET en .env');

const app = express();
app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1); // detrás de nginx con HTTPS en el VPS

// Cabeceras de seguridad: solo corre el código del propio panel (CSP), nadie lo
// puede meter en un iframe (clickjacking) y la API no se guarda en caché.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Los archivos de precios e inventario (Excel de varios MB) llegan en base64 por JSON.
const jsonSmall = express.json({ limit: '1mb' });
const jsonFiles = express.json({ limit: '1mb' }); // llegan en partes de 512 KB (ver /stock-price/upload)
app.use((req, res, next) => (req.path === '/api/sync/stock-price/upload' ? jsonFiles : jsonSmall)(req, res, next));
app.use(session({
  name: 'wayan.sid',
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'solo-para-desarrollo',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 12 },
}));
app.use(loadUser);

// Las peticiones que modifican algo deben ser JSON: junto con sameSite=lax,
// evita que otro sitio dispare acciones con un formulario (CSRF).
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ ok: false, message: 'Se esperaba JSON.' });
  }
  next();
});

// Para monitoreo: responde si el panel y la base de datos están vivos.
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sync', requireAuth, require('./routes/sync'));
app.use('/api/users', requirePermission('users'), require('./routes/users'));
app.use('/api/connections', requirePermission('connections'), require('./routes/connections'));

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.use((error, _req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  if (status >= 500) console.error(error);
  // Los errores de la base de datos traen detalles internos (tablas, consultas): no se muestran.
  const internal = status >= 500 && (error.severity || /^[0-9A-Z]{5}$/.test(String(error.code || '')));
  res.status(status).json({ ok: false, message: internal ? 'Error interno del panel. Avisa al administrador.' : (error.message || 'Error interno') });
});

migrate()
  .then(() => app.listen(PORT, HOST, () => console.log(`Panel Wayan Sync en http://${HOST}:${PORT} · ${require('../woo/http').describeRoute()}`)))
  .catch((error) => {
    console.error('No se pudo preparar la base de datos:', error.message);
    process.exit(1);
  });
