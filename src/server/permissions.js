// Qué puede hacer cada perfil en el panel.
//   can:     acciones permitidas.
//   fields:  campos que puede subir a la tienda (null = todos).
//   history: tipos de sincronización que ve en el Historial (null = todos).
const EXCEL_RUNS = ['pull', 'review', 'push', 'undo'];
const PHOTO_RUNS = ['photos-review', 'photos'];

const ROLES = {
  admin: {
    label: 'Administrador',
    can: ['pull', 'pull:force', 'push', 'create', 'undo', 'photos', 'history', 'users', 'connections'],
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

const can = (role, action) => Boolean(ROLES[role]?.can.includes(action));
const allowedFields = (role) => (ROLES[role]?.fields ? new Set(ROLES[role].fields) : null);
const historyTypes = (role) => (ROLES[role] ? ROLES[role].history : []);

module.exports = { ROLES, can, allowedFields, historyTypes };
