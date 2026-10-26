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

app.use(express.json({ limit: '1mb' }));
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
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ ok: false, message: error.message || 'Error interno' });
});

migrate()
  .then(() => app.listen(PORT, HOST, () => console.log(`Panel Wayan Sync en http://${HOST}:${PORT}`)))
  .catch((error) => {
    console.error('No se pudo preparar la base de datos:', error.message);
    process.exit(1);
  });
