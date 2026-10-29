// Qué puede hacer cada perfil en el panel.
//   can:     acciones permitidas.
//   fields:  campos que puede subir a la tienda (null = todos).
//   history: tipos de sincronización que ve en el Historial (null = todos).
const EXCEL_RUNS = ['pull', 'review', 'push', 'undo'];
const PHOTO_RUNS = ['photos-review', 'photos', 'photos-link'];

// Permisos que el administrador da o quita a cada usuario, aparte de su perfil.
const GRANTABLE = {
  delete: 'Eliminar productos y variaciones (y convertir simples en variaciones)',
  orphans: 'Ver el reporte de variantes sueltas',
};

const ROLES = {
  admin: {
    label: 'Administrador',
    can: ['pull', 'pull:force', 'push', 'create', 'undo', 'photos', 'history', 'users', 'connections', 'attributes', ...Object.keys(GRANTABLE)],
    fields: null,
    history: null,
  },
  excel: {
    label: 'Catálogo (Excel)',
    can: ['pull', 'pull:force', 'push', 'create', 'undo', 'history'],
    fields: null,
    history: EXCEL_RUNS,
  },
  fotos: {
    label: 'Fotos',
    can: ['photos', 'history'],
    fields: [],
    history: PHOTO_RUNS,
  },
};

// Permisos efectivos de un usuario: los de su perfil más los que le asignó el administrador.
function permissionsOf(user) {
  const role = ROLES[user?.role];
  if (!role) return [];
  const extra = (user.extra_permissions || []).filter((p) => GRANTABLE[p]);
  return [...new Set([...role.can, ...extra])];
}

const can = (user, action) => permissionsOf(user).includes(action);
const allowedFields = (role) => (ROLES[role]?.fields ? new Set(ROLES[role].fields) : null);
const historyTypes = (role) => (ROLES[role] ? ROLES[role].history : []);

module.exports = { ROLES, GRANTABLE, permissionsOf, can, allowedFields, historyTypes };
