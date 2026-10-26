const express = require('express');
const { pool } = require('../db');
const { findUserByUsername, verifyPassword, setPassword, publicUser, requireAuth } = require('../auth');

const router = express.Router();

// Freno simple contra fuerza bruta: 10 intentos fallidos por IP cada 15 minutos.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

function tooManyAttempts(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) return false;
  return entry.count >= MAX_FAILURES;
}

function registerFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

router.post('/login', async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ ok: false, message: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: 'Escribe usuario y contraseña.' });

    const user = await findUserByUsername(String(username).trim());
    const valid = user?.active && await verifyPassword(String(password), user.password_salt, user.password_hash);
    if (!valid) {
      registerFailure(req.ip);
      return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos.' });
    }

    failures.delete(req.ip);
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
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
