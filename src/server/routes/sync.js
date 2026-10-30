const express = require('express');
const config = require('../../config');
const state = require('../../state');
const pull = require('../../commands/pull');
const push = require('../../commands/push');
const photos = require('../../commands/photos');
const attributes = require('../../commands/attributes');
const backup = require('../../push/backup');
const { undoInStore, refreshExcel } = require('../../push/undo');
const jobs = require('../jobs');
const { pool } = require('../db');
const { requirePermission } = require('../auth');
const { can, allowedFields, historyTypes } = require('../permissions');
const dashboard = require('../../photos/dashboard');
const { loadLinks, saveLink, removeLink } = require('../../photos/links');
const orphans = require('../../report/orphans');
const { TYPE } = require('../../push/fields');

const router = express.Router();

// Enlaces de un producto/variación: la página en la tienda y su edición en WordPress.
function linksOf(item) {
  const data = item.result?.data;
  if (!item.result?.ok || !data) return { url: null, adminUrl: null };
  const productId = item.type === TYPE.variation ? (data.parent_id || item.parentId) : data.id;
  return {
    url: data.permalink || null,
    adminUrl: productId ? `${config.woo.url().replace(/\/$/, '')}/wp-admin/post.php?post=${productId}&action=edit` : null,
  };
}

// Última revisión de cambios ("Revisar cambios"), lista para "Subir a la tienda".
let pendingReview = null;
const REVIEW_TTL_MS = 30 * 60 * 1000;

// Estado general para la pantalla principal.
router.get('/status', (_req, res) => {
  const excelPath = config.excelPath();
  res.json({ ok: true, excelPath, lastPull: state.get(excelPath), current: jobs.getCurrent('excel') });
});

// Avance de la tarea en curso de un área: ?lane=excel (por defecto) o ?lane=photos.
router.get('/current', (req, res) => {
  res.json({ ok: true, current: jobs.getCurrent(req.query.lane === 'photos' ? 'photos' : 'excel') });
});

// ---------- Tablero de fotos ----------
router.get('/photos/dashboard', requirePermission('photos'), (_req, res) => {
  res.json({ ok: true, ...dashboard.getDashboard(), current: jobs.getCurrent('photos') });
});

router.post('/photos/dashboard/refresh', requirePermission('photos'), (_req, res) => {
  dashboard.refreshDashboard(pool);
  res.status(202).json({ ok: true, ...dashboard.getDashboard() });
});

// ---------- Relacionar a mano una carpeta cuyo nombre no coincide con ningún SKU ----------
// Queda en el Historial (área de fotos) quién relacionó o quitó qué carpeta.
async function logLink(user, { folderPath, oldSku, newSku }) {
  const summary = newSku ? { Carpeta: folderPath, 'Relacionada con': newSku } : { Carpeta: folderPath, 'Se quitó la relación con': oldSku };
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (type, user_id, status, finished_at, summary) VALUES ('photos-link', $1, 'success', now(), $2) RETURNING id`,
    [user.id, JSON.stringify(summary)],
  );
  await pool.query(
    'INSERT INTO change_log (run_id, woo_id, sku, field, old_value, new_value, result) VALUES ($1,NULL,$2,$3,$4,$5,$6)',
    [rows[0].id, newSku || oldSku, 'Carpeta de fotos', oldSku || null, newSku ? `${folderPath} → ${newSku}` : null, 'ok'],
  );
}

// Paso previo: a qué producto iría (para confirmar antes de guardar).
router.post('/photos/links/check', requirePermission('photos'), async (req, res, next) => {
  try {
    res.json({ ok: true, target: await photos.checkSku(req.body?.sku) });
  } catch (error) {
    error.status ??= 400;
    next(error);
  }
});

router.post('/photos/links', requirePermission('photos'), async (req, res, next) => {
  try {
    const { folderId, folderPath } = req.body || {};
    if (!folderId || typeof folderId !== 'string' || folderId.length > 200) return res.status(400).json({ ok: false, message: 'Falta la carpeta.' });
    if (folderPath !== undefined && (typeof folderPath !== 'string' || folderPath.length > 1000)) return res.status(400).json({ ok: false, message: 'Ruta de carpeta inválida.' });
    const target = await photos.checkSku(req.body?.sku);
    await saveLink(pool, { folderId: String(folderId), folderPath, sku: target.sku, userId: req.user.id });
    await logLink(req.user, { folderPath, newSku: target.sku });
    dashboard.forgetWarning(String(folderId));
    dashboard.refreshDashboard(pool);
    res.status(201).json({ ok: true, target, ...dashboard.getDashboard() });
  } catch (error) {
    error.status ??= 400;
    next(error);
  }
});

router.delete('/photos/links/:folderId', requirePermission('photos'), async (req, res, next) => {
  try {
    const removed = await removeLink(pool, req.params.folderId);
    if (!removed) return res.status(404).json({ ok: false, message: 'Esa carpeta no tenía relación.' });
    await logLink(req.user, { folderPath: removed.folder_path, oldSku: removed.sku });
    dashboard.refreshDashboard(pool);
    res.json({ ok: true, ...dashboard.getDashboard() });
  } catch (error) {
    next(error);
  }
});

// ---------- Reporte de variantes sueltas (permiso que asigna el administrador) ----------
router.get('/orphans', requirePermission('orphans'), (_req, res) => {
  res.json({ ok: true, ...orphans.getReport() });
});

router.post('/orphans/refresh', requirePermission('orphans'), (_req, res) => {
  orphans.refreshReport();
  res.status(202).json({ ok: true, ...orphans.getReport() });
});

router.post('/pull', requirePermission('pull'), async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    if (force && !can(req.user, 'pull:force')) {
      return res.status(403).json({ ok: false, message: 'Tu perfil no puede sobrescribir el Excel cuando tiene cambios.' });
    }
    const job = await jobs.start('pull', req.user, ({ log, progress }) => pull({
      force,
      log,
      onProgress: (done, total) => progress(done, total, 'Leyendo variaciones'),
    }));
    pendingReview = null;
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

// Paso 1 del push: comparar el Excel contra la tienda sin modificar nada.
router.post('/review', requirePermission('push'), async (req, res, next) => {
  try {
    const user = req.user;
    const job = await jobs.start('review', user, async ({ log }) => {
      const reviewed = await push.review({
        allowedFields: allowedFields(user.role),
        canCreate: can(user, 'create'),
        canDelete: can(user, 'delete'),
        log,
      });
      pendingReview = { userId: user.id, reviewed };
      return { summary: reviewed.plan.summary, details: push.publicPlan(reviewed.plan), webUrl: reviewed.source.webUrl };
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

// Paso 2 del push: aplicar la revisión anterior en la tienda.
router.post('/push', requirePermission('push'), async (req, res, next) => {
  try {
    const review = pendingReview;
    if (!review || String(review.userId) !== String(req.user.id)) {
      return res.status(400).json({ ok: false, message: 'Primero haz "Revisar cambios".' });
    }
    if (Date.now() - review.reviewed.reviewedAt > REVIEW_TTL_MS) {
      pendingReview = null;
      return res.status(400).json({ ok: false, message: 'La revisión tiene más de 30 minutos. Vuelve a "Revisar cambios".' });
    }
    pendingReview = null;

    const job = await jobs.start('push', req.user, async ({ runId, log, progress }) => {
      // Sin respaldo no se sube nada: si esto falla, la tienda queda intacta.
      const snapshot = await backup.snapshotBefore(review.reviewed.plan, { log });
      try {
        const result = await push.applyReview(review.reviewed, {
          log,
          onProgress: (done, total) => progress(done, total, 'Guardando en la tienda'),
        });
        result.warnings.forEach(log);
        return {
          summary: result.summary,
          details: { ...push.publicPlan(review.reviewed.plan), results: resultsOf(review.reviewed.plan), warnings: result.warnings, createdTerms: result.createdTerms },
          webUrl: result.webUrl,
        };
      } finally {
        await backup.saveBackup(pool, runId, review.reviewed.plan, snapshot).catch((e) => console.error('No se pudo guardar el respaldo del push:', e.message));
        await saveChangeLog(runId, review.reviewed.plan).catch((e) => console.error('No se pudo guardar el historial de cambios:', e.message));
      }
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

// ---------- Reparación de atributos (solo administrador) ----------
let pendingAttributes = null;

router.post('/attributes/review', requirePermission('attributes'), async (req, res, next) => {
  try {
    const user = req.user;
    const job = await jobs.start('attrs-review', user, async ({ log, progress }) => {
      const review = await attributes.reviewAttributes({ log, progress });
      pendingAttributes = { userId: user.id, review };
      return { summary: review.summary, details: attributes.publicAttributes(review) };
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

router.post('/attributes/fix', requirePermission('attributes'), async (req, res, next) => {
  try {
    const pending = pendingAttributes;
    if (!pending || String(pending.userId) !== String(req.user.id)) {
      return res.status(400).json({ ok: false, message: 'Primero haz "Revisar atributos".' });
    }
    if (Date.now() - pending.review.reviewedAt > REVIEW_TTL_MS) {
      pendingAttributes = null;
      return res.status(400).json({ ok: false, message: 'La revisión tiene más de 30 minutos. Vuelve a "Revisar atributos".' });
    }
    pendingAttributes = null;

    const job = await jobs.start('attrs-fix', req.user, async ({ runId, log, progress }) => {
      try {
        const result = await attributes.applyAttributes(pending.review, { log, progress });
        return { summary: result.summary, details: attributes.publicAttributes(pending.review, { withResults: true }) };
      } finally {
        // Historial con cómo estaban y cómo quedaron, y respaldo de los atributos originales.
        for (const item of pending.review.items.filter((i) => i.result)) {
          await pool.query(
            'INSERT INTO change_log (run_id, woo_id, sku, field, old_value, new_value, result, error, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [runId, item.id, item.sku, 'Atributos', attributes.attrSummary(item.before), attributes.attrSummary(item.attributes), item.result.ok ? 'ok' : 'error', item.result.ok ? null : item.result.message, item.url],
          ).catch((e) => console.error('No se pudo guardar el historial de atributos:', e.message));
          await pool.query(
            `INSERT INTO push_backups (run_id, kind, action, woo_id, sku, fields, before) VALUES ($1,'product','update',$2,$3,'["attributes"]'::jsonb,$4)`,
            [runId, item.id, item.sku, JSON.stringify({ attributes: item.before })],
          ).catch((e) => console.error('No se pudo guardar el respaldo de atributos:', e.message));
        }
      }
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

// ---------- Fotos ----------
let pendingPhotos = null;

router.post('/photos/review', requirePermission('photos'), async (req, res, next) => {
  try {
    const user = req.user;
    const job = await jobs.start('photos-review', user, async ({ log, progress }) => {
      const review = await photos.reviewPhotos({ log, progress, links: await loadLinks(pool) });
      pendingPhotos = { userId: user.id, review };
      return { summary: review.summary, details: photos.publicPhotos(review) };
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

router.post('/photos/push', requirePermission('photos'), async (req, res, next) => {
  try {
    const pending = pendingPhotos;
    if (!pending || String(pending.userId) !== String(req.user.id)) {
      return res.status(400).json({ ok: false, message: 'Primero haz "Revisar fotos".' });
    }
    if (Date.now() - pending.review.reviewedAt > REVIEW_TTL_MS) {
      pendingPhotos = null;
      return res.status(400).json({ ok: false, message: 'La revisión tiene más de 30 minutos. Vuelve a "Revisar fotos".' });
    }
    pendingPhotos = null;

    const job = await jobs.start('photos', req.user, async ({ runId, log, progress }) => {
      try {
        const result = await photos.applyPhotos(pending.review, { pool, runId, log, progress });
        if (result.notMoved.length) log(`No se movieron a YA SUBIDAS (revisa errores): ${result.notMoved.join(', ')}`);
        dashboard.refreshDashboard(pool); // el tablero se pone al día solo
        return { summary: result.summary, details: photos.publicPhotos(pending.review, { withResults: true }) };
      } finally {
        for (const item of pending.review.items.filter((i) => i.result)) {
          await pool.query(
            'INSERT INTO change_log (run_id, woo_id, sku, field, old_value, new_value, result, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [runId, item.target.id || item.target.parentId, item.label, 'Fotos', null, item.files.map((f) => f.name).join(', '), item.result.ok ? 'ok' : 'error', item.result.ok ? null : item.result.message],
          ).catch((e) => console.error('No se pudo guardar el historial de fotos:', e.message));
        }
      }
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

function resultsOf(plan) {
  return plan.items.filter((i) => i.result).map((i) => ({ row: i.row, sku: i.data.sku ?? null, ok: i.result.ok, message: i.result.message, newId: i.result.newId || null, ...linksOf(i) }));
}

// Guarda campo por campo lo que se intentó subir y con qué resultado.
async function saveChangeLog(runId, plan) {
  const values = [];
  for (const item of plan.items.filter((i) => i.result)) {
    const { url } = linksOf(item);
    for (const change of item.changes) {
      values.push([
        runId,
        item.result.newId || item.id,
        item.data.sku ?? null,
        change.header,
        change.from === null || change.from === undefined ? null : String(change.from),
        change.to === null || change.to === undefined ? null : String(change.to),
        item.result.ok ? 'ok' : 'error',
        item.result.ok ? null : item.result.message,
        url,
      ]);
    }
  }
  for (const v of values) {
    await pool.query(
      'INSERT INTO change_log (run_id, woo_id, sku, field, old_value, new_value, result, error, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      v,
    );
  }
}

// Solo se puede deshacer el último push que se completó, una vez, y si tiene respaldo.
async function undoableRunId() {
  const { rows } = await pool.query(
    `SELECT r.id, r.undone_at, EXISTS (SELECT 1 FROM push_backups b WHERE b.run_id = r.id) AS has_backup
     FROM sync_runs r WHERE r.type = 'push' AND r.status = 'success'
     ORDER BY r.started_at DESC LIMIT 1`,
  );
  const last = rows[0];
  return last && last.has_backup && !last.undone_at ? String(last.id) : null;
}

router.post('/runs/:id/undo', requirePermission('undo'), async (req, res, next) => {
  try {
    const target = String(req.params.id);
    if (target !== await undoableRunId()) {
      return res.status(400).json({ ok: false, message: 'Solo se puede deshacer el último push, una sola vez (y solo los que tienen respaldo).' });
    }
    const job = await jobs.start('undo', req.user, async ({ runId, log, progress }) => {
      const { rows: backups } = await pool.query('SELECT * FROM push_backups WHERE run_id = $1 ORDER BY id', [target]);
      const { results, refreshed } = await undoInStore(backups, { log, progress });
      await pool.query('UPDATE sync_runs SET undone_at = now(), undone_by_run = $2 WHERE id = $1', [target, runId]);
      pendingReview = null;
      for (const r of results) {
        await pool.query(
          'INSERT INTO change_log (run_id, woo_id, sku, field, old_value, new_value, result, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [runId, null, r.sku, 'Deshacer', null, r.message, r.ok ? 'ok' : 'error', r.ok ? null : r.message],
        ).catch((e) => console.error('No se pudo guardar el historial del deshacer:', e.message));
      }

      const warnings = [];
      let webUrl = null;
      try {
        log('Actualizando las filas afectadas en el Excel...');
        ({ webUrl } = await refreshExcel(refreshed, { log }));
      } catch (error) {
        warnings.push(`La tienda SÍ quedó como antes, pero no se pudo actualizar el Excel: ${error.message}. Haz "Traer de la tienda" antes de seguir editando.`);
        log(warnings[0]);
      }
      const ok = results.filter((r) => r.ok).length;
      const summary = { 'Deshechos correctamente': ok, 'Con aviso (revisar)': results.length - ok };
      return {
        summary,
        webUrl,
        details: {
          summary,
          notes: [`Se deshizo el push #${target}. Las categorías o etiquetas que ese push creó se conservan.`],
          warnings,
          items: results.map((r, i) => ({ row: i + 1, kind: 'update', type: '', sku: r.sku, name: null, attributes: null, changes: [], conflicts: [], skipped: [], errors: [], warnings: [] })),
          results: results.map((r, i) => ({ row: i + 1, sku: r.sku, ok: r.ok, message: r.message })),
        },
      };
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

router.get('/runs', requirePermission('history'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const undoable = await undoableRunId();
    const types = historyTypes(req.user.role); // null = todo el historial
    const { rows } = await pool.query(
      `SELECT r.id, r.type, r.status, r.started_at, r.finished_at, r.summary, r.error, r.undone_at, u.display_name AS user_name,
              (SELECT count(*) FROM change_log c WHERE c.run_id = r.id)::int AS changes
       FROM sync_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE $2::text[] IS NULL OR r.type = ANY($2::text[])
       ORDER BY r.started_at DESC LIMIT $1`,
      [limit, types],
    );
    res.json({ ok: true, runs: rows.map((r) => ({ ...r, undoable: String(r.id) === undoable })) });
  } catch (error) {
    next(error);
  }
});

router.get('/runs/:id/changes', requirePermission('history'), async (req, res, next) => {
  try {
    const types = historyTypes(req.user.role);
    if (types) {
      const { rows: run } = await pool.query('SELECT type FROM sync_runs WHERE id = $1', [req.params.id]);
      if (!run[0] || !types.includes(run[0].type)) return res.status(403).json({ ok: false, message: 'No tienes acceso a esa sincronización.' });
    }
    const { rows } = await pool.query(
      'SELECT woo_id, sku, field, old_value, new_value, result, error, url FROM change_log WHERE run_id = $1 ORDER BY id',
      [req.params.id],
    );
    res.json({ ok: true, changes: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
