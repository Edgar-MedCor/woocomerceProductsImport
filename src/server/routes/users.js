const express = require('express');
const { pool } = require('../db');
const { createUser, setPassword, validateRole, findUserById, publicUser } = require('../auth');
const { ROLES } = require('../permissions');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY active DESC, display_name');
    res.json({
      ok: true,
      users: rows.map(publicUser),
      roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, can: r.can })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { username, password, displayName, role } = req.body || {};
    const user = await createUser({ username: String(username || '').trim(), password, displayName, role });
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (error) {
    error.status ??= 400;
    next(error);
  }
});

// Cambiar nombre, rol, activar/desactivar o restablecer contraseña.
router.patch('/:id', async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });

    const { displayName, role, active, password } = req.body || {};
    const isSelf = String(target.id) === String(req.user.id);
    if (isSelf && (active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ ok: false, message: 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo.' });
    }
    if (role !== undefined) validateRole(role);

    await pool.query(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         role = COALESCE($3, role),
         active = COALESCE($4, active)
       WHERE id = $1`,
      [target.id, displayName || null, role || null, typeof active === 'boolean' ? active : null],
    );
    if (password) await setPassword(target.id, password);

    res.json({ ok: true, user: publicUser(await findUserById(target.id)) });
  } catch (error) {
    error.status ??= 400;
    next(error);
  }
});

module.exports = router;
