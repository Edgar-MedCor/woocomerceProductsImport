const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let me = null;
let pollTimer = null;
// Área cuya tarea se muestra: 'excel' (pestaña Catálogo) o 'photos' (pestaña Fotos).
let activeLane = 'excel';
const laneOf = (type) => (type?.startsWith('photos') ? 'photos' : 'excel');

// ---------- utilidades ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') showLogin();
  if (!res.ok || data.ok === false) {
    const error = new Error(data.message || `Error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

// Botón para mostrar u ocultar lo escrito en los campos de contraseña.
const EYE_SVG = {
  show: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  hide: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
};
$$('input[type="password"]').forEach((input) => {
  const wrap = el('span', { class: 'pass-wrap' });
  input.replaceWith(wrap);
  const eye = el('button', { type: 'button', class: 'pass-toggle' });
  const render = (visible) => {
    eye.innerHTML = visible ? EYE_SVG.hide : EYE_SVG.show;
    eye.title = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
    eye.setAttribute('aria-label', eye.title);
  };
  render(false);
  eye.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    render(visible);
    input.focus();
  });
  wrap.append(input, eye);
  // Al enviar el formulario vuelve a ocultarse.
  input.form?.addEventListener('submit', () => { input.type = 'password'; render(false); });
});

const fmtDate = (d) => (d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const can = (perm) => me?.permissions.includes(perm);
const TYPE_LABEL = {
  pull: 'Traer de la tienda',
  review: 'Revisar cambios',
  push: 'Subir a la tienda',
  'photos-review': 'Revisar fotos',
  photos: 'Subir fotos',
  undo: 'Deshacer push',
};
// Qué revisión habilita qué subida.
const PUSH_STEP = {
  review: { endpoint: '/sync/push', pending: (s) => (s['Productos/variaciones nuevos'] || 0) + (s['Productos/variaciones con cambios'] || 0) + (s['Ya existían en la tienda (se vinculan)'] || 0), label: (n) => `Subir ${n} producto(s) con cambios a la tienda` },
  'photos-review': { endpoint: '/sync/photos/push', pending: (s) => s['Productos/colores con fotos nuevas'] || 0, label: (n) => `Subir fotos de ${n} producto(s)/color(es)` },
};
const STATUS_LABEL = { running: 'En curso', success: 'Terminado', error: 'Con error' };

// ---------- sesión ----------
function showLogin() {
  me = null;
  clearInterval(pollTimer);
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userName').textContent = `${me.displayName} · ${me.roleLabel}`;
  $$('[data-perm]').forEach((node) => node.classList.toggle('hidden', !can(node.dataset.perm)));
  switchTab(can('pull') ? 'sync' : can('photos') ? 'photos' : 'history');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#loginError').textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    me = data.user;
    e.target.reset();
    showApp();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

$('#passwordBtn').addEventListener('click', async () => {
  const currentPassword = prompt('Contraseña actual:');
  if (!currentPassword) return;
  const newPassword = prompt('Nueva contraseña (mínimo 8 caracteres):');
  if (!newPassword) return;
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
    alert('Contraseña actualizada.');
  } catch (error) {
    alert(error.message);
  }
});

// ---------- pestañas ----------
function switchTab(tab) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== tab));
  // La tarjeta de avance es una sola: se muestra en la pestaña del área activa.
  const slot = $(`[data-view="${tab}"] .job-slot`);
  if (slot) {
    slot.append($('#jobCard'));
    activeLane = tab === 'photos' ? 'photos' : 'excel';
  }
  clearInterval(pollTimer);
  ({ sync: loadSync, photos: loadPhotos, history: loadHistory, users: loadUsers, connections: loadConnections })[tab]?.();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- sincronizar ----------
async function loadSync() {
  const { excelPath, lastPull, current } = await api('/sync/status');
  $('#excelInfo').textContent = lastPull
    ? `${excelPath} · último "traer de la tienda": ${lastPull.pulledAt}`
    : `${excelPath} · todavía no se ha traído nada de la tienda.`;
  const link = $('#excelLink');
  link.classList.toggle('hidden', !lastPull?.webUrl);
  if (lastPull?.webUrl) link.href = lastPull.webUrl;
  renderJob(current);
  if (current?.status === 'running') startPolling();
}

async function startPull(force = false) {
  try {
    const { job } = await api('/sync/pull', { method: 'POST', body: { force } });
    renderJob(job);
    startPolling();
  } catch (error) {
    alert(error.message);
  }
}
$('#pullBtn').addEventListener('click', () => startPull(false));

async function startJob(path) {
  try {
    const { job } = await api(path, { method: 'POST', body: {} });
    activeLane = laneOf(job.type);
    renderJob(job);
    startPolling();
  } catch (error) {
    alert(error.message);
  }
}
$('#reviewBtn').addEventListener('click', () => startJob('/sync/review'));
$('#photosReviewBtn').addEventListener('click', () => startJob('/sync/photos/review'));
$('#pushBtn').addEventListener('click', () => {
  if (confirm(`${$('#pushBtn').textContent}. Los cambios se verán en la tienda. ¿Continuar?`)) startJob($('#pushBtn').dataset.endpoint);
});
$('#forcePullBtn').addEventListener('click', () => {
  if (confirm('Se reemplazará el Excel con lo que hay en la tienda. Los cambios que no se hayan subido se perderán (OneDrive guarda la versión anterior en su historial). ¿Continuar?')) startPull(true);
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const lane = activeLane;
      const { current } = await api(`/sync/current?lane=${lane}`);
      renderJob(current);
      if (current?.status !== 'running') {
        clearInterval(pollTimer);
        if (lane === 'photos') loadPhotos(); else loadSync();
      }
    } catch {
      clearInterval(pollTimer);
    }
  }, 2000);
}

function renderJob(job) {
  const card = $('#jobCard');
  card.classList.toggle('hidden', !job);
  const running = job?.status === 'running';
  if (activeLane === 'photos') $('#photosReviewBtn').disabled = running;
  else {
    $('#pullBtn').disabled = running;
    $('#reviewBtn').disabled = running;
  }
  renderPlan(job);
  if (!job) return;

  $('#jobTitle').textContent = `${TYPE_LABEL[job.type] || job.type} · ${job.user.displayName} · ${fmtDate(job.startedAt)}`;
  const badge = $('#jobBadge');
  badge.textContent = STATUS_LABEL[job.status];
  badge.className = `badge ${job.status}`;

  const p = job.progress;
  $('#jobProgress').classList.toggle('hidden', !(p && job.status === 'running'));
  if (p) $('#jobProgress div').style.width = `${Math.round((p.done / p.total) * 100)}%`;
  const lastLog = job.log.at(-1)?.message;
  $('#jobProgressText').textContent = job.status === 'running'
    ? (p ? (p.total ? `${p.label}: ${p.done} de ${p.total}` : `${p.label}: ${p.done}`) : lastLog || 'Iniciando…')
    : (job.status === 'success' ? `Terminó ${fmtDate(job.finishedAt)}` : '');

  $('#jobError').classList.toggle('hidden', !job.error);
  $('#jobError').textContent = job.error || '';
  $('#forcePullBtn').classList.toggle('hidden', !(job.errorCode === 'EXCEL_MODIFIED' && can('pull:force')));

  const summary = $('#jobSummary');
  summary.classList.toggle('hidden', !job.summary);
  summary.replaceChildren(...Object.entries(job.summary || {}).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, String(v)))));

  $('#jobLog').replaceChildren(...job.log.map((l) => el('li', {}, `${new Date(l.at).toLocaleTimeString('es-MX')} — ${l.message}`)));
}

// ---------- revisión / resultado del push ----------
let planFilter = 'all';
let lastPlanJob = null;
const MAX_PLAN_ROWS = 500;

$$('.filters .chip').forEach((chip) => chip.addEventListener('click', () => {
  planFilter = chip.dataset.filter;
  $$('.filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderPlan(lastPlanJob);
}));

function renderPlan(job) {
  // Cada revisión nueva empieza mostrando todo (el filtro anterior podía ocultarla).
  if (job && job.id !== lastPlanJob?.id) {
    planFilter = 'all';
    $$('.filters .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
  }
  lastPlanJob = job;
  const details = job?.details;
  $('#planView').classList.toggle('hidden', !details);
  if (!details) return;

  const s = details.summary || {};
  const step = PUSH_STEP[job.type];
  const pending = step ? step.pending(s) : 0;
  const canPush = step && job.status === 'success' && String(job.user.id) === String(me.id) && pending > 0;
  $('#pushBtn').classList.toggle('hidden', !canPush);
  if (step) {
    $('#pushBtn').textContent = step.label(pending);
    $('#pushBtn').dataset.endpoint = step.endpoint;
  }
  $('#rowHead').textContent = job.type.startsWith('photos') ? 'Carpeta' : 'Fila';
  $('#jobExcelLink').classList.toggle('hidden', !job.webUrl);
  if (job.webUrl) $('#jobExcelLink').href = job.webUrl;

  const notes = [...(details.notes || []), ...(details.warnings || [])];
  const t = details.newTerms || {};
  if (step) {
    if (t.categories?.length) notes.push(`Se crearán categorías nuevas: ${t.categories.join(', ')}`);
    if (t.tags?.length) notes.push(`Se crearán etiquetas nuevas: ${t.tags.join(', ')}`);
    if (t.brands?.length) notes.push(`Se crearán marcas nuevas: ${t.brands.join(', ')}`);
    if (!pending && job.status === 'success') notes.push('No hay cambios para subir.');
  }
  $('#planNotes').replaceChildren(...notes.map((n) => el('li', {}, n)));

  const results = new Map((details.results || []).map((r) => [r.row, r]));
  $('#resultHead').classList.toggle('hidden', !results.size);

  const visible = (details.items || []).filter((i) => {
    if (planFilter === 'errors') return i.errors.length;
    if (planFilter === 'conflicts') return i.conflicts.length || i.skipped.length;
    if (planFilter === 'changes') return i.changes.length && !i.errors.length;
    return true;
  });

  const rows = visible.slice(0, MAX_PLAN_ROWS).map((i) => {
    const what = el('ul', {},
      i.errors.map((e) => el('li', { class: 'err' }, `✖ ${e}`)),
      i.conflicts.map((c) => el('li', { class: 'conf' }, `⚠ ${c.field}: alguien lo cambió en la tienda a "${c.store}" (en el Excel: "${c.excel}"). No se sube.`)),
      i.skipped.map((c) => el('li', { class: 'conf' }, `⚠ ${c.field}: ${c.reason}`)),
      i.errors.length ? [] : i.changes.map((c) => el('li', {}, `${c.field}: `, c.from !== null ? el('span', { class: 'from' }, c.from) : null, c.from !== null ? ' → ' : '', c.to)),
      i.warnings.map((w) => el('li', { class: 'muted' }, w)),
    );
    const r = results.get(i.row);
    return el('tr', {},
      el('td', {}, String(i.row)),
      el('td', {},
        el('span', { class: `tag ${i.kind}` }, { create: 'Nuevo', link: 'Ya existe' }[i.kind] || 'Cambio'),
        `${i.type || ''} · `, el('strong', {}, i.sku || '(sin SKU)'),
        el('div', { class: 'muted' }, [i.name, i.attributes].filter(Boolean).join(' · '))),
      el('td', {}, what),
      results.size ? el('td', { class: r ? (r.ok ? '' : 'err') : 'muted' }, r ? `${r.ok ? '✔' : '✖'} ${r.message}${r.newId ? ` (ID ${r.newId})` : ''}` : '—') : null,
    );
  });
  if (visible.length > MAX_PLAN_ROWS) rows.push(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, `… y ${visible.length - MAX_PLAN_ROWS} filas más (ver la columna "Resultado último push" del Excel).`)));
  if (!visible.length) rows.push(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Nada que mostrar con este filtro.')));
  $('#planBody').replaceChildren(...rows);
}

// ---------- tablero de fotos ----------
let dashData = null;
let dashTimer = null;

async function loadPhotos() {
  const { dashboard, refreshing, current } = await api('/sync/photos/dashboard');
  renderJob(current);
  if (current?.status === 'running') startPolling();
  dashData = dashboard;
  renderDashboard(refreshing);
  if (!dashboard && !refreshing) await refreshDashboard();
  else if (refreshing) watchDashboard();
}

async function refreshDashboard() {
  await api('/sync/photos/dashboard/refresh', { method: 'POST', body: {} });
  renderDashboard(true);
  watchDashboard();
}

function watchDashboard() {
  clearInterval(dashTimer);
  dashTimer = setInterval(async () => {
    const { dashboard, refreshing } = await api('/sync/photos/dashboard').catch(() => ({}));
    if (refreshing) return;
    clearInterval(dashTimer);
    dashData = dashboard;
    renderDashboard(false);
  }, 3000);
}
$('#dashRefreshBtn').addEventListener('click', refreshDashboard);
['#dashSearch', '#dashOnlyPublished', '#dashOnlyMissing'].forEach((sel) => $(sel).addEventListener('input', () => renderNoPhotos()));

function renderDashboard(refreshing) {
  const d = dashData;
  $('#dashRefreshBtn').disabled = refreshing;
  $('#dashRefreshBtn').textContent = refreshing ? 'Actualizando… (puede tardar unos minutos)' : 'Actualizar tablero';
  $('#dashUpdated').textContent = d?.updatedAt ? `Actualizado ${fmtDate(d.updatedAt)}` : '';
  const error = d?.error || d?.pending?.error;
  $('#dashError').classList.toggle('hidden', !error);
  $('#dashError').textContent = error || '';
  if (!d?.pending) return;

  $('#dashPendingPath').textContent = d.folders.pending;
  $('#dashDonePath').textContent = d.folders.done;
  $('#tilePending').textContent = d.pending.listos;
  $('#tilePendingPhotos').textContent = d.pending.fotos;
  $('#tileBlocked').textContent = d.pending.bloqueados + d.avisos.length;
  $('#tileNoPhotos').textContent = d.sinFotos.total;
  $('#tileUploaded').textContent = d.subidas.d7;

  const none = (cols, text) => el('tr', {}, el('td', { colspan: cols, class: 'muted' }, text));
  $('#dashCategories').replaceChildren(...(d.pending.porCategoria.length
    ? d.pending.porCategoria.map((c) => el('tr', {}, el('td', {}, c.categoria), el('td', {}, String(c.carpetas)), el('td', {}, String(c.fotos)), el('td', { class: c.bloqueadas ? 'err' : 'muted' }, String(c.bloqueadas))))
    : [none(4, 'No hay carpetas pendientes.')]));
  $('#dashWarnings').replaceChildren(...(d.avisos.length
    ? d.avisos.map((w) => el('li', {}, el('strong', {}, w.path), ` — ${w.message}`))
    : [el('li', { class: 'muted' }, 'Sin avisos.')]));
  $('#dashPending').replaceChildren(...(d.pending.items.length
    ? d.pending.items.map((i) => el('tr', {}, el('td', { class: 'muted' }, i.path), el('td', {}, el('strong', {}, i.sku), el('div', { class: 'muted' }, i.name || '')), el('td', {}, String(i.fotos)), el('td', { class: i.ok ? '' : 'err' }, i.estado)))
    : [none(4, 'No hay carpetas pendientes.')]));
  $('#dashRecent').replaceChildren(...(d.subidas.recientes.length
    ? d.subidas.recientes.map((r) => el('tr', {}, el('td', {}, r.sku), el('td', {}, String(r.fotos)), el('td', {}, fmtDate(r.fecha)), el('td', {}, r.usuario || '—')))
    : [none(4, 'Todavía no se han subido fotos desde el panel.')]));
  renderNoPhotos();
}

function renderNoPhotos() {
  const d = dashData;
  if (!d?.sinFotos) return;
  const q = $('#dashSearch').value.trim().toLowerCase();
  const list = d.sinFotos.items.filter((p) => (!$('#dashOnlyPublished').checked || p.status === 'Publicado')
    && (!$('#dashOnlyMissing').checked || !p.pendienteEnCarpeta)
    && (!q || `${p.sku} ${p.name} ${p.categoria}`.toLowerCase().includes(q)));
  $('#dashNoPhotosInfo').textContent = `${d.sinFotos.total} en total · ${d.sinFotos.publicados} publicados · ${d.sinFotos.conCarpetaPendiente} ya tienen carpeta pendiente`;
  const rows = list.slice(0, 300).map((p) => el('tr', {},
    el('td', {}, p.sku), el('td', {}, p.name), el('td', {}, p.type), el('td', { class: 'muted' }, p.categoria), el('td', {}, p.status),
    el('td', { class: p.pendienteEnCarpeta ? '' : 'muted' }, p.pendienteEnCarpeta ? '✔ Pendiente de subir' : 'Sin carpeta')));
  if (list.length > 300) rows.push(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, `… y ${list.length - 300} más (usa el buscador).`)));
  if (!list.length) rows.push(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nada que mostrar.')));
  $('#dashNoPhotos').replaceChildren(...rows);
}

// ---------- historial ----------
async function loadHistory() {
  const { runs } = await api('/sync/runs');
  $('#runsBody').replaceChildren(...(runs.length ? runs.map((r) => {
    const detail = el('td', { class: 'muted' }, r.error || Object.entries(r.summary || {}).filter(([, v]) => v).map(([k, v]) => `${k.trim()}: ${v}`).join(' · '));
    const row = el('tr', {},
      el('td', {}, fmtDate(r.started_at)),
      el('td', {}, TYPE_LABEL[r.type] || r.type),
      el('td', {}, r.user_name || '—'),
      el('td', {}, el('span', { class: `badge ${r.status}` }, STATUS_LABEL[r.status]), r.undone_at ? el('div', { class: 'muted' }, `↩ Deshecho ${fmtDate(r.undone_at)}`) : null),
      detail,
    );
    if (r.changes) {
      detail.append(' ', el('button', { class: 'small secondary', onclick: (e) => toggleChanges(r.id, row, e.target) }, `Ver ${r.changes} cambio(s)`));
    }
    if (r.undoable && can('undo')) {
      detail.append(' ', el('button', { class: 'small danger', onclick: () => undoRun(r.id) }, '↩ Deshacer este push'));
    }
    return row;
  }) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'Todavía no hay sincronizaciones.'))]));
}

async function undoRun(runId) {
  const ok = confirm('Se regresarán a como estaban los productos que cambió este push, y se borrará lo que creó (si nadie lo modificó después). Las filas afectadas del Excel se actualizarán. ¿Continuar?');
  if (!ok) return;
  try {
    const { job } = await api(`/sync/runs/${runId}/undo`, { method: 'POST', body: {} });
    switchTab('sync');
    renderJob(job);
    startPolling();
  } catch (error) {
    alert(error.message);
  }
}

async function toggleChanges(runId, row, button) {
  if (row.nextSibling?.classList?.contains('run-detail')) {
    row.nextSibling.remove();
    button.textContent = button.textContent.replace('Ocultar', 'Ver');
    return;
  }
  const { changes } = await api(`/sync/runs/${runId}/changes`);
  const table = el('table', { class: 'small-table' },
    el('tr', {}, ['SKU', 'Campo', 'Antes', 'Después', 'Resultado'].map((h) => el('th', {}, h))),
    changes.map((c) => el('tr', {},
      el('td', {}, c.sku || `ID ${c.woo_id}`),
      el('td', {}, c.field),
      el('td', { class: 'muted' }, c.old_value ?? '(vacío)'),
      el('td', {}, c.new_value ?? '(vacío)'),
      el('td', { class: c.result === 'ok' ? '' : 'err' }, c.result === 'ok' ? '✔' : `✖ ${c.error || ''}`))));
  row.after(el('tr', { class: 'run-detail' }, el('td', { colspan: 5 }, table)));
  button.textContent = button.textContent.replace('Ver', 'Ocultar');
}

// ---------- usuarios ----------
let roles = [];
async function loadUsers() {
  const data = await api('/users');
  roles = data.roles;
  $('#roleSelect').replaceChildren(...roles.map((r) => el('option', { value: r.key }, r.label)));
  $('#rolesHelp').replaceChildren(...roles.map((r) => el('li', {}, el('strong', {}, `${r.label}: `), describePerms(r.can))));

  $('#usersBody').replaceChildren(...data.users.map((u) => {
    const roleSelect = el('select', { onchange: (e) => updateUser(u.id, { role: e.target.value }) },
      roles.map((r) => {
        const opt = el('option', { value: r.key }, r.label);
        if (r.key === u.role) opt.selected = true;
        return opt;
      }));
    return el('tr', { class: u.active ? '' : 'inactive' },
      el('td', {}, u.displayName),
      el('td', {}, u.username),
      el('td', {}, roleSelect),
      el('td', {}, fmtDate(u.lastLoginAt)),
      el('td', {}, u.active ? 'Activo' : 'Desactivado'),
      el('td', {},
        el('button', { class: 'small secondary', onclick: () => updateUser(u.id, { active: !u.active }) }, u.active ? 'Desactivar' : 'Activar'),
        ' ',
        el('button', { class: 'small secondary', onclick: () => resetPassword(u) }, 'Contraseña')),
    );
  }));
}

function describePerms(perms) {
  const labels = { pull: 'traer de la tienda', 'pull:force': 'sobrescribir el Excel', push: 'subir a la tienda', create: 'crear productos', photos: 'subir fotos', undo: 'deshacer el último push', history: 'ver historial', users: 'administrar usuarios', connections: 'administrar conexiones' };
  return perms.map((p) => labels[p] || p).join(', ');
}

async function updateUser(id, changes) {
  try {
    await api(`/users/${id}`, { method: 'PATCH', body: changes });
  } catch (error) {
    alert(error.message);
  }
  loadUsers();
}

async function resetPassword(user) {
  const password = prompt(`Nueva contraseña para ${user.displayName} (mínimo 8 caracteres):`);
  if (password) await updateUser(user.id, { password });
}

$('#newUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try {
    await api('/users', { method: 'POST', body: form });
    $('#newUserMsg').textContent = `Usuario ${form.username} creado.`;
    e.target.reset();
    loadUsers();
  } catch (error) {
    $('#newUserMsg').textContent = error.message;
  }
});

// ---------- conexiones ----------
async function loadConnections() {
  $('#onedriveStatus').textContent = 'Comprobando…';
  $('#wooStatus').textContent = 'Comprobando…';
  const data = await api('/connections');
  const od = data.onedrive;
  const where = !od.root ? '' : od.root.error
    ? ` ⚠ Carpeta raíz: ${od.root.error}`
    : ` Carpeta raíz: ${od.root.type === 'sharepoint' ? `SharePoint › ${od.root.name}` : od.root.name}.`;
  $('#onedriveStatus').textContent = od.connected
    ? `Conectado como ${od.user} (${od.email}).${where} Excel: ${od.excelPath}`
    : `No conectado.${od.error ? ` ${od.error}` : ''}`;
  $('#onedriveConnectBtn').classList.toggle('hidden', od.connected);
  $('#onedriveDisconnectBtn').classList.toggle('hidden', !od.connected);
  showCode(od.pending);

  $('#wooStatus').textContent = data.woo.ok
    ? `Conectado a ${data.woo.url}`
    : `Sin conexión con ${data.woo.url || '(falta WOO_URL)'}: ${data.woo.error}`;
}

function showCode(code) {
  const box = $('#onedriveCode');
  box.classList.toggle('hidden', !code);
  if (!code) return;
  box.replaceChildren(
    'Abre ', el('a', { href: code.verificationUri, target: '_blank', rel: 'noopener' }, code.verificationUri),
    ', escribe el código ', el('strong', {}, code.userCode),
    ' e inicia sesión con la cuenta de Microsoft dueña del Excel. Luego vuelve a esta pestaña y recárgala.',
  );
}

$('#onedriveConnectBtn').addEventListener('click', async () => {
  try {
    const { code } = await api('/connections/onedrive/connect', { method: 'POST', body: {} });
    showCode(code);
  } catch (error) {
    alert(error.message);
  }
});

$('#onedriveDisconnectBtn').addEventListener('click', async () => {
  if (!confirm('El panel dejará de poder leer y escribir el Excel hasta que alguien lo vuelva a conectar. ¿Desconectar?')) return;
  await api('/connections/onedrive/disconnect', { method: 'POST', body: {} });
  loadConnections();
});

// ---------- arranque ----------
api('/auth/me')
  .then((data) => { me = data.user; showApp(); })
  .catch(() => showLogin());
