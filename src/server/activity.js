// Avisos del equipo: lo que hicieron OTRAS personas en los últimos días y que le
// importa a quien lo ve según su perfil (p. ej. Fotos se entera de los productos
// nuevos; Catálogo, de los cambios que dejan vieja su revisión). Se arman con lo que
// ya queda guardado en sync_runs y change_log; no hay tabla de avisos.

const WINDOW_DAYS = 7;
const MAX_NOTICES = 50;
const MAX_SKUS = 15;

// Qué tipos de sincronización le llegan a cada perfil.
const AUDIENCE = {
  admin: ['push', 'undo', 'pull', 'photos', 'merge', 'attrs-fix'],
  excel: ['push', 'undo', 'pull', 'photos', 'merge', 'attrs-fix'],
  fotos: ['push', 'merge'],
};

const num = (v) => Number(v) || 0;

/**
 * Convierte las sincronizaciones de otros en avisos para el perfil `role`.
 * `runs`: [{ id, type, finished_at, summary, user_name, new_skus }].
 * Devuelve [{ id, at, tone, text, skus }] (más reciente primero).
 */
function buildNotices(runs, role) {
  const types = AUDIENCE[role] || [];
  const notices = [];
  for (const run of runs) {
    if (!types.includes(run.type)) continue;
    const who = run.user_name || 'Alguien';
    const s = run.summary || {};
    const newSkus = (run.new_skus || []).filter(Boolean);
    const skus = newSkus.slice(0, MAX_SKUS);
    const notice = (tone, text, withSkus = false) => notices.push({ id: String(run.id), at: run.finished_at, tone, text, skus: withSkus ? skus : [], moreSkus: withSkus ? Math.max(0, newSkus.length - MAX_SKUS) : 0 });

    switch (run.type) {
      case 'push': {
        if (role === 'fotos') {
          if (newSkus.length) notice('info', `${who} subió ${newSkus.length} producto(s)/variación(es) nuevos a la tienda: revisa si tienen fotos.`, true);
          break;
        }
        const saved = num(s['Guardados correctamente']);
        const parts = [`${saved} guardado(s)`];
        if (num(s['Enviados a la papelera'])) parts.push(`${num(s['Enviados a la papelera'])} a la papelera`);
        if (newSkus.length) parts.push(`${newSkus.length} nuevo(s)`);
        notice('warning', `${who} subió cambios a la tienda (${parts.join(', ')}). Si tenías una revisión pendiente, quedó vieja: vuelve a revisar.`, newSkus.length > 0);
        break;
      }
      case 'undo':
        notice('warning', `${who} deshizo un push: la tienda regresó a como estaba antes. Si tenías una revisión pendiente, vuelve a revisar.`);
        break;
      case 'pull':
        notice('info', `${who} actualizó el Excel con lo que hay en la tienda ("Traer de la tienda").`);
        break;
      case 'photos': {
        const n = num(s['Productos/colores con fotos asignadas']);
        if (n) notice('info', `${who} subió fotos de ${n} producto(s)/color(es).`);
        break;
      }
      case 'merge': {
        const n = num(s['Estilos corregidos']);
        if (n) notice('warning', `${who} juntó ${n} estilo(s) en modelos de la tienda (los productos por color pasaron a ser colores de un solo producto). Haz "Traer de la tienda" antes de editar el Excel.`);
        break;
      }
      case 'attrs-fix': {
        const n = num(s['Productos corregidos']);
        if (n) notice('info', `${who} corrigió los atributos de ${n} producto(s). Haz "Traer de la tienda" antes de editar el Excel.`);
        break;
      }
      default:
        break;
    }
  }
  return notices.slice(0, MAX_NOTICES);
}

/** Avisos para `user`, marcando como no leídos los posteriores a la última vez que los vio. */
async function loadActivity(pool, user) {
  const types = AUDIENCE[user.role] || [];
  if (!types.length) return { notices: [], unread: 0 };
  const { rows } = await pool.query(
    `SELECT r.id, r.type, r.finished_at, r.summary, u.display_name AS user_name,
            (SELECT array_agg(DISTINCT c.sku) FROM change_log c
              WHERE c.run_id = r.id AND c.field = 'SKU' AND c.old_value IS NULL AND c.result = 'ok') AS new_skus
     FROM sync_runs r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.status = 'success' AND r.type = ANY($1::text[])
       AND r.user_id IS DISTINCT FROM $2
       AND r.finished_at > now() - make_interval(days => $3)
     ORDER BY r.finished_at DESC
     LIMIT 200`,
    [types, user.id, WINDOW_DAYS],
  );
  const seen = user.last_seen_activity_at ? new Date(user.last_seen_activity_at) : null;
  const notices = buildNotices(rows, user.role).map((n) => ({ ...n, unread: !seen || new Date(n.at) > seen }));
  return { notices, unread: notices.filter((n) => n.unread).length };
}

async function markSeen(pool, userId) {
  await pool.query('UPDATE users SET last_seen_activity_at = now() WHERE id = $1', [userId]);
}

module.exports = { buildNotices, loadActivity, markSeen, AUDIENCE, WINDOW_DAYS };
