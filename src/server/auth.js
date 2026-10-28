const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');
const { ROLES, can, permissionsOf } = require('./permissions');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password, salt, expectedHash) {
  const derived = await scrypt(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function validatePassword(password) {
  if (!password || String(password).length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
}

function validateRole(role) {
  if (!ROLES[role]) throw new Error(`Rol inválido. Usa uno de: ${Object.keys(ROLES).join(', ')}`);
}

async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser({ username, password, displayName, role }) {
  validatePassword(password);
  validateRole(role);
  if (!/^[a-z0-9._-]{3,40}$/i.test(username || '')) {
    throw new Error('El usuario debe tener de 3 a 40 caracteres: letras, números, punto, guion o guion bajo.');
  }
  if (await findUserByUsername(username)) throw new Error(`Ya existe el usuario "${username}".`);
  const { salt, hash } = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, password_salt, display_name, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [username, hash, salt, displayName || username, role],
  );
  return rows[0];
}

async function setPassword(userId, password) {
  validatePassword(password);
  const { salt, hash } = await hashPassword(password);
  await pool.query('UPDATE users SET password_hash = $2, password_salt = $3 WHERE id = $1', [userId, hash, salt]);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    roleLabel: ROLES[user.role]?.label || user.role,
    active: user.active,
    lastLoginAt: user.last_login_at,
    permissions: permissionsOf(user),
    extraPermissions: user.extra_permissions || [],
  };
}

// Carga el usuario de la sesión en cada petición, para que desactivar a alguien
// o cambiarle el rol tenga efecto inmediato.
async function loadUser(req, _res, next) {
  try {
    if (req.session?.userId) {
      const user = await findUserById(req.session.userId);
      if (user?.active) req.user = user;
      else req.session.destroy(() => {});
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, message: 'Inicia sesión.' });
  next();
}

function requirePermission(action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: 'Inicia sesión.' });
    if (!can(req.user, action)) return res.status(403).json({ ok: false, message: 'Tu perfil no tiene permiso para esta acción.' });
    next();
  };
}

module.exports = {
  verifyPassword,
  findUserByUsername,
  findUserById,
  createUser,
  setPassword,
  validateRole,
  publicUser,
  loadUser,
  requireAuth,
  requirePermission,
};
