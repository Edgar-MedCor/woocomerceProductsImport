const express = require('express');
const { pool } = require('../db');
const { createUser, setPassword, validateRole, findUserById, publicUser, endSessions } = require('../auth');
const { ROLES, GRANTABLE } = require('../permissions');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY active DESC, display_name');
    res.json({
      ok: true,
      users: rows.map(publicUser),
      roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, can: r.can })),
      grantable: Object.entries(GRANTABLE).map(([key, label]) => ({ key, label })),
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

// Cambiar nombre, rol, permisos extra, activar/desactivar o restablecer contraseña.
router.patch('/:id', async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target || target.deleted_at) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });

    const { displayName, role, active, password, permissions } = req.body || {};
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 80)) {
      return res.status(400).json({ ok: false, message: 'El nombre debe tener máximo 80 caracteres.' });
    }
    const isSelf = String(target.id) === String(req.user.id);
    if (isSelf && (active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ ok: false, message: 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo.' });
    }
    if (role !== undefined) validateRole(role);
    if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((p) => !GRANTABLE[p]))) {
      return res.status(400).json({ ok: false, message: `Permisos inválidos. Usa: ${Object.keys(GRANTABLE).join(', ')}` });
    }

    await pool.query(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         role = COALESCE($3, role),
         active = COALESCE($4, active),
         extra_permissions = COALESCE($5, extra_permissions)
       WHERE id = $1`,
      [target.id, displayName || null, role || null, typeof active === 'boolean' ? active : null, permissions ? [...new Set(permissions)] : null],
    );
    if (password) await setPassword(target.id, password);
    // Contraseña restablecida o usuario desactivado: se cierran sus sesiones abiertas.
    if (password || active === false) await endSessions(target.id, isSelf ? req.sessionID : null);

    res.json({ ok: true, user: publicUser(await findUserById(target.id)) });
  } catch (error) {
    error.status ??= 400;
    next(error);
  }
});

// Eliminar: deja de aparecer y no puede volver a entrar. No se borra la fila para
// que el historial siga diciendo quién hizo cada cambio; su nombre de usuario queda
// libre para usarse de nuevo.
router.delete('/:id', async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target || target.deleted_at) return res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
    if (String(target.id) === String(req.user.id)) {
      return res.status(400).json({ ok: false, message: 'No puedes eliminarte a ti mismo.' });
    }
    await pool.query(
      `UPDATE users SET deleted_at = now(), active = false, extra_permissions = '{}',
         username = username || '~eliminado-' || id, password_hash = '', password_salt = ''
       WHERE id = $1`,
      [target.id],
    );
    await endSessions(target.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
