const { pool } = require('./db');
const throttle = require('../woo/throttle');
const { describeRoute } = require('../woo/http');

// Una sincronización a la vez POR ÁREA: dos tareas del Excel (traer, revisar,
// subir, deshacer) podrían pisarse, pero las fotos no tocan el Excel y pueden
// correr al mismo tiempo. El avance vive en memoria para mostrarlo en vivo; el
// resultado final queda en sync_runs.
const current = { excel: null, photos: null };
const laneOf = (type) => (type.startsWith('photos') ? 'photos' : 'excel');
const MAX_LOG = 200;

function publicJob(job) {
  if (!job) return null;
  const { id, type, status, startedAt, finishedAt, user, progress, log, summary, details, error, errorCode, webUrl } = job;
  return { id, type, status, startedAt, finishedAt, user, progress, log, summary, details, error, errorCode, webUrl };
}

function getCurrent(lane = 'excel') {
  return publicJob(current[lane] || null);
}

/**
 * Arranca `task(ctx)` en segundo plano. ctx = { runId, log(msg), progress(done, total, label) }.
 * La tarea devuelve { summary, details?, webUrl? }.
 */
async function start(type, user, task) {
  const lane = laneOf(type);
  if (current[lane]?.status === 'running') {
    const err = new Error(`Ya hay una sincronización ${lane === 'photos' ? 'de fotos' : 'del Excel'} en curso (${current[lane].user.displayName}). Espera a que termine.`);
    err.status = 409;
    throw err;
  }

  const { rows } = await pool.query(
    'INSERT INTO sync_runs (type, user_id, status) VALUES ($1, $2, $3) RETURNING id, started_at',
    [type, user.id, 'running'],
  );

  const job = {
    id: rows[0].id,
    type,
    status: 'running',
    startedAt: rows[0].started_at,
    finishedAt: null,
    user: { id: user.id, displayName: user.display_name },
    progress: null,
    log: [],
    summary: null,
    details: null,
    error: null,
    errorCode: null,
    webUrl: null,
  };
  current[lane] = job;

  const ctx = {
    runId: job.id,
    log: (message) => {
      job.log.push({ at: new Date().toISOString(), message });
      if (job.log.length > MAX_LOG) job.log.shift();
    },
    progress: (done, total, label) => { job.progress = { done, total, label }; },
  };

  // No se espera: el panel consulta el avance con GET /api/sync/current.
  (async () => {
    // Si la tienda pide bajar el ritmo, el Detalle lo dice (en vez de parecer atorado).
    const stopListening = throttle.onPause(ctx.log);
    ctx.log(describeRoute());
    try {
      const result = await task(ctx);
      Object.assign(job, { status: 'success', summary: result?.summary || null, details: result?.details || null, webUrl: result?.webUrl || null });
    } catch (error) {
      const detail = error.response?.data?.message;
      Object.assign(job, { status: 'error', error: detail ? `${error.message} — ${detail}` : error.message, errorCode: error.code || null });
    } finally {
      stopListening();
      job.finishedAt = new Date().toISOString();
      await pool.query(
        'UPDATE sync_runs SET status = $2, finished_at = now(), summary = $3, error = $4 WHERE id = $1',
        [job.id, job.status, job.summary ? JSON.stringify(job.summary) : null, job.error],
      ).catch((e) => console.error('No se pudo guardar el resultado de la sincronización:', e.message));
    }
  })();

  return publicJob(job);
}

module.exports = { start, getCurrent, laneOf };
