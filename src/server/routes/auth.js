const express = require('express');
const { pool } = require('../db');
const { findUserByUsername, verifyPassword, checkLogin, endSessions, setPassword, publicUser, requireAuth } = require('../auth');

const router = express.Router();

// Freno contra fuerza bruta: 10 intentos fallidos por IP y 10 por usuario cada
// 15 minutos (el de usuario frena a quien prueba desde muchas IPs).
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function tooManyAttempts(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

setInterval(() => {
  for (const [k, e] of failures) if (Date.now() - e.first > WINDOW_MS) failures.delete(k);
}, WINDOW_MS).unref();

function registerFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length > 100 || password.length > 200) {
      return res.status(400).json({ ok: false, message: 'Escribe usuario y contraseña.' });
    }
    const userKey = `u:${username.trim().toLowerCase()}`;
    if (tooManyAttempts(req.ip) || tooManyAttempts(userKey)) {
      return res.status(429).json({ ok: false, message: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }

    const user = await findUserByUsername(username.trim());
    if (!(await checkLogin(user, password))) {
      registerFailure(req.ip);
      registerFailure(userKey);
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos.' });
    }

    failures.delete(req.ip);
    failures.delete(userKey);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.json({ ok: true, user: publicUser(user) });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wayan.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const valid = await verifyPassword(String(currentPassword || ''), req.user.password_salt, req.user.password_hash);
    if (!valid) return res.status(400).json({ ok: false, message: 'La contraseña actual no es correcta.' });
    await setPassword(req.user.id, newPassword);
    await endSessions(req.user.id, req.sessionID); // se cierran sus otras sesiones (otro equipo, etc.)
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
