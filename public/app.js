const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let me = null;
// Consulta periódica de la tarea en curso de cada área; sigue aunque se cambie de pestaña.
const watchers = {};
const stopWatchers = () => Object.keys(watchers).forEach((lane) => { clearInterval(watchers[lane]); delete watchers[lane]; });
// Área cuya tarea se muestra: 'excel' (pestaña Catálogo) o 'photos' (pestaña Fotos).
let activeLane = 'excel';
const laneOf = (type) => (type?.startsWith('photos') ? 'photos' : 'excel');

// ---------- utilidades ----------
// Barra de carga arriba de la página mientras hay peticiones en curso.
let inflight = 0;
const setLoading = (delta) => {
  inflight = Math.max(0, inflight + delta);
  document.body.classList.toggle('is-loading', inflight > 0);
};

// Mensaje entendible para cada falla del servidor.
function serverMessage(status, data) {
  if (data.message) return data.message;
  if (status === 502 || status === 503 || status === 504) return 'El servidor no respondió a tiempo. Espera unos segundos e inténtalo de nuevo.';
  if (status >= 500) return `El servidor tuvo un problema (error ${status}). Inténtalo de nuevo; si sigue, avisa al administrador.`;
  if (status === 403) return 'Tu perfil no tiene permiso para esta acción.';
  if (status === 404) return 'No se encontró lo que buscabas. Recarga la página.';
  return `Algo salió mal (error ${status}).`;
}

/** `quiet`: sin barra de carga (consultas automáticas cada pocos segundos). */
async function api(path, { method = 'GET', body, quiet = false } = {}) {
  if (!quiet) setLoading(1);
  try {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const error = new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
      error.status = 0;
      throw error;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !['/auth/login', '/auth/me'].includes(path)) {
      if (me) toast('Tu sesión terminó. Vuelve a iniciar sesión.', 'warning');
      showLogin();
    }
    if (!res.ok || data.ok === false) {
      const error = new Error(serverMessage(res.status, data));
      error.status = res.status;
      throw error;
    }
    return data;
  } finally {
    if (!quiet) setLoading(-1);
  }
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
function attachEye(input) {
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
}
$$('input[type="password"]').forEach(attachEye);

// ---------- íconos, avisos flotantes y ventana propia (en lugar de alert/confirm/prompt) ----------
const svg = (paths) => {
  const span = el('span', { class: 'icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
};
const ICON = {
  success: () => svg('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'),
  error: () => svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  warning: () => svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  info: () => svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  close: () => svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};

/** Aviso flotante arriba a la derecha que se cierra solo. type: success | error | warning | info */
function toast(message, type = 'info') {
  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    ICON[type](), el('div', { class: 'toast-msg' }, message));
  const close = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  node.append(el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Cerrar aviso', onclick: close }, ICON.close()));
  $('#toasts').append(node);
  setTimeout(close, type === 'error' ? 9000 : 5000);
}

/**
 * Ventana del panel. Sin `fields` es una confirmación; con `fields` es un
 * formulario con validación por campo ({ name, label, type, validate(valor, todos) -> mensaje }).
 * `onSubmit(valores)` puede ser async: si lanza error, se muestra dentro de la
 * ventana y no se cierra. Resuelve con los valores (o true), o null si se cancela.
 * tone: 'default' | 'warning' | 'danger'
 */
function openModal({ title, body = null, tone = 'default', okText = 'Aceptar', cancelText = 'Cancelar', fields = [], onSubmit = null }) {
  const dlg = $('#modal');
  const form = $('#modalForm');
  const ok = $('#modalOk');
  const cancel = $('#modalCancel');
  return new Promise((resolve) => {
    dlg.className = `modal ${tone}`;
    $('#modalTitle').textContent = title;
    $('#modalIcon').replaceChildren(ICON[tone === 'default' ? 'info' : 'warning']());
    $('#modalError').textContent = '';
    ok.textContent = okText;
    ok.className = tone === 'danger' ? 'danger' : '';
    cancel.textContent = cancelText;

    const inputs = fields.map((f) => {
      const input = el('input', { name: f.name, type: f.type || 'text', autocomplete: f.autocomplete || 'off', ...(f.placeholder ? { placeholder: f.placeholder } : {}) });
      const error = el('span', { class: 'field-error', id: `modal-err-${f.name}` });
      input.setAttribute('aria-describedby', error.id);
      input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
      const label = el('label', { class: 'field' }, f.label, input, error);
      return { f, input, error, label };
    });
    const content = typeof body === 'string' ? el('p', {}, body) : body;
    $('#modalBody').replaceChildren(...[content].filter(Boolean), ...inputs.map((i) => i.label));
    inputs.filter((i) => i.f.type === 'password').forEach((i) => attachEye(i.input));

    let busy = false;
    const finish = (value) => {
      form.removeEventListener('submit', submit);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(value);
    };
    function onCancel(e) {
      e?.preventDefault();
      if (!busy) finish(null);
    }
    async function submit(e) {
      e.preventDefault();
      if (busy) return;
      const values = Object.fromEntries(inputs.map(({ f, input }) => [f.name, input.value]));
      let firstBad = null;
      for (const { f, input, error } of inputs) {
        const message = f.validate?.(values[f.name], values) || '';
        error.textContent = message;
        if (message) {
          input.setAttribute('aria-invalid', 'true');
          firstBad ??= input;
        }
      }
      if (firstBad) return firstBad.focus();
      if (!onSubmit) return finish(inputs.length ? values : true);
      busy = true;
      const label = ok.textContent;
      ok.disabled = true;
      cancel.disabled = true;
      ok.textContent = 'Un momento…';
      $('#modalError').textContent = '';
      try {
        const result = await onSubmit(values);
        busy = false;
        finish(result ?? values);
      } catch (error) {
        $('#modalError').textContent = error.message;
      } finally {
        busy = false;
        ok.disabled = false;
        cancel.disabled = false;
        ok.textContent = label;
      }
    }
    form.addEventListener('submit', submit);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    // En acciones peligrosas el foco empieza en "Cancelar" para no confirmar por accidente.
    (inputs[0]?.input || (tone === 'danger' ? cancel : ok)).focus();
  });
}

const confirmModal = (options) => openModal(options).then(Boolean);

const spinner = () => el('span', { class: 'spinner', 'aria-hidden': 'true' });

/**
 * Mientras `fn` corre, el botón queda desactivado con un indicador y `text`
 * (evita doble clic y muestra que algo está pasando). Al terminar vuelve a como estaba.
 */
async function busy(button, text, fn) {
  if (!button) return fn();
  if (button.dataset.busy) return undefined;
  const saved = [...button.childNodes];
  const wasDisabled = button.disabled;
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.replaceChildren(spinner(), text);
  try {
    return await fn();
  } finally {
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
    button.replaceChildren(...saved);
    button.disabled = wasDisabled;
  }
}

// Fila de tabla "Cargando…" (o un mensaje) mientras llegan los datos.
const loadingRow = (cols, text = 'Cargando…') => el('tr', { class: 'loading-row' }, el('td', { colspan: cols }, spinner(), ` ${text}`));
const messageRow = (cols, text, cls = 'muted') => el('tr', {}, el('td', { colspan: cols, class: cls }, text));

// Lista "Etiqueta: valor" para el cuerpo de una ventana.
const facts = (pairs) => el('dl', { class: 'facts' }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

// Validaciones compartidas.
const SKU_FORMAT = /^[A-Z0-9][A-Z0-9._-]{1,59}$/i;
const validateSku = (v) => {
  const sku = v.trim();
  if (!sku) return 'Escribe el SKU.';
  if (!SKU_FORMAT.test(sku)) return 'Solo letras, números, guion, punto o guion bajo, sin espacios.';
  return '';
};
const validateNewPassword = (v) => (v.length < 8 ? 'Debe tener al menos 8 caracteres.' : '');
const validateRepeat = (field) => (v, all) => (v === all[field] ? '' : 'Las contraseñas no coinciden.');

// Errores de un formulario de la página (no de la ventana), junto a cada campo.
function showFieldErrors(form, errors) {
  let first = null;
  form.querySelectorAll('[data-for]').forEach((span) => {
    const message = errors[span.dataset.for] || '';
    span.textContent = message;
    const input = form.elements[span.dataset.for];
    if (input) input.toggleAttribute('aria-invalid', Boolean(message));
    if (message && !first) first = input;
  });
  first?.focus();
  return !first;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const can = (perm) => me?.permissions.includes(perm);
const TYPE_LABEL = {
  pull: 'Traer de la tienda',
  review: 'Revisar cambios',
  push: 'Subir a la tienda',
  'photos-review': 'Revisar fotos',
  photos: 'Subir fotos',
  undo: 'Deshacer push',
  'photos-link': 'Relacionar carpeta',
  'attrs-review': 'Revisar atributos',
  'attrs-fix': 'Corregir atributos',
};
// Qué revisión habilita qué subida.
const PUSH_STEP = {
  review: {
    endpoint: '/sync/push',
    pending: (s) => ['Productos/variaciones nuevos', 'Productos/variaciones con cambios', 'Simples que pasan a variación', 'A eliminar (papelera)', 'Ya existían en la tienda (se vinculan)'].reduce((n, k) => n + (s[k] || 0), 0),
    label: (n) => `Subir ${n} producto(s) con cambios a la tienda`,
  },
  'photos-review': { endpoint: '/sync/photos/push', pending: (s) => (s['Productos/colores con fotos nuevas'] || 0) + (s['Productos padre sin foto (se arma su galería)'] || 0), label: (n) => `Subir fotos de ${n} producto(s)/color(es)` },
  'attrs-review': { endpoint: '/sync/attributes/fix', pending: (s) => s['Productos a corregir'] || 0, label: (n) => `Corregir atributos de ${n} producto(s)` },
};
const STATUS_LABEL = { running: 'En curso', success: 'Terminado', error: 'Con error' };

// ---------- sesión ----------
function showLogin() {
  me = null;
  stopWatchers();
  $('#bootView').classList.add('hidden');
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#loginForm input[name="username"]').focus();
}

function showApp() {
  $('#bootView').classList.add('hidden');
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
  if (!String(form.get('username')).trim() || !form.get('password')) {
    $('#loginError').textContent = 'Escribe tu usuario y tu contraseña.';
    return;
  }
  const inputs = $$('#loginForm input');
  inputs.forEach((i) => { i.readOnly = true; });
  try {
    const data = await busy(e.target.querySelector('button[type="submit"]'), 'Entrando…',
      () => api('/auth/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } }));
    me = data.user;
    e.target.reset();
    showApp();
    toast(`Hola, ${me.displayName}.`, 'success');
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally {
    inputs.forEach((i) => { i.readOnly = false; });
  }
});

$('#logoutBtn').addEventListener('click', async (e) => {
  await busy(e.currentTarget, 'Saliendo…', () => api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}));
  showLogin();
  toast('Sesión cerrada.', 'info');
});

$('#passwordBtn').addEventListener('click', async () => {
  const done = await openModal({
    title: 'Cambiar contraseña',
    okText: 'Guardar',
    fields: [
      { name: 'currentPassword', label: 'Contraseña actual', type: 'password', autocomplete: 'current-password', validate: (v) => (v ? '' : 'Escribe tu contraseña actual.') },
      { name: 'newPassword', label: 'Nueva contraseña (mínimo 8 caracteres)', type: 'password', autocomplete: 'new-password', validate: (v, all) => validateNewPassword(v) || (v === all.currentPassword ? 'Debe ser distinta de la actual.' : '') },
      { name: 'again', label: 'Repite la nueva contraseña', type: 'password', autocomplete: 'new-password', validate: validateRepeat('newPassword') },
    ],
    onSubmit: ({ currentPassword, newPassword }) => api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
  });
  if (done) toast('Contraseña actualizada.', 'success');
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
  const loader = { sync: loadSync, photos: loadPhotos, orphans: loadOrphans, history: loadHistory, users: loadUsers, connections: loadConnections }[tab];
  Promise.resolve(loader?.()).catch((error) => toast(`No se pudo cargar esta sección: ${error.message}`, 'error'));
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- sincronizar ----------
async function loadSync() {
  if (!$('#excelInfo').dataset.loaded) $('#excelInfo').replaceChildren(spinner(), ' Consultando el Excel…');
  const { excelPath, lastPull, current } = await api('/sync/status');
  $('#excelInfo').dataset.loaded = '1';
  $('#excelInfo').textContent = lastPull
    ? `${excelPath} · último "traer de la tienda": ${lastPull.pulledAt}`
    : `${excelPath} · todavía no se ha traído nada de la tienda.`;
  const link = $('#excelLink');
  link.classList.toggle('hidden', !lastPull?.webUrl);
  if (lastPull?.webUrl) link.href = lastPull.webUrl;
  renderJob(current);
  if (current?.status === 'running') startPolling();
}

// Arranca una tarea larga (traer, revisar, subir, deshacer) y avisa que ya está corriendo.
async function launch(button, request) {
  try {
    const { job } = await busy(button, 'Iniciando…', request);
    activeLane = laneOf(job.type);
    renderJob(job);
    startPolling();
    toast(`${TYPE_LABEL[job.type] || 'Tarea'}: en curso. Puedes seguir usando el panel; te aviso cuando termine.`, 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}
const startPull = (force = false, button = null) => launch(button, () => api('/sync/pull', { method: 'POST', body: { force } }));
const startJob = (path, button = null) => launch(button, () => api(path, { method: 'POST', body: {} }));
$('#pullBtn').addEventListener('click', (e) => startPull(false, e.currentTarget));
$('#reviewBtn').addEventListener('click', (e) => startJob('/sync/review', e.currentTarget));
$('#photosReviewBtn').addEventListener('click', (e) => startJob('/sync/photos/review', e.currentTarget));
$('#attrsReviewBtn').addEventListener('click', (e) => startJob('/sync/attributes/review', e.currentTarget));
$('#pushBtn').addEventListener('click', async () => {
  const s = lastPlanJob?.details?.summary || {};
  if (lastPlanJob?.type === 'attrs-review') {
    const ok = await confirmModal({
      title: 'Corregir atributos en la tienda',
      tone: 'warning',
      okText: 'Corregir atributos',
      body: el('div', {},
        el('p', {}, 'Solo se cambia la configuración de los atributos; precios, inventario y lo demás no se tocan.'),
        facts([
          ['Productos', s['Productos a corregir']],
          ['Se prenden para variaciones', s['Atributos que se prenden para variaciones'] || null],
          ['Se apagan para variaciones', s['Atributos que se apagan para variaciones'] || null],
          ['Pasan de local a global', s['Atributos locales que pasan a globales'] || null],
        ]),
        el('p', { class: 'callout warning' }, 'Este cambio no se puede deshacer desde el panel. Lo anterior queda guardado en el Historial de cada producto.')),
    });
    if (ok) startJob('/sync/attributes/fix', $('#pushBtn'));
    return;
  }
  const isPhotos = lastPlanJob?.type === 'photos-review';
  const trashed = (s['A eliminar (papelera)'] || 0) + (s['Simples que pasan a variación'] || 0);
  const ok = await confirmModal({
    title: isPhotos ? 'Subir fotos a la tienda' : 'Subir cambios a la tienda',
    tone: trashed ? 'warning' : 'default',
    okText: isPhotos ? 'Subir fotos' : 'Subir a la tienda',
    body: el('div', {},
      el('p', {}, 'Los cambios se verán en la tienda en cuanto termine.'),
      facts(isPhotos
        ? [['Productos/colores', s['Productos/colores con fotos nuevas']], ['Fotos', s['Fotos a subir']], ['Padres sin foto (se arma su galería)', s['Productos padre sin foto (se arma su galería)'] || null]]
        : [
          ['Nuevos', s['Productos/variaciones nuevos'] || null],
          ['Con cambios', s['Productos/variaciones con cambios'] || null],
          ['Simples que pasan a variación', s['Simples que pasan a variación'] || null],
          ['A la papelera', s['A eliminar (papelera)'] || null],
          ['Ya existían (se vinculan)', s['Ya existían en la tienda (se vinculan)'] || null],
        ]),
      trashed ? el('p', { class: 'callout warning' }, `${trashed} producto(s)/variación(es) se mandarán a la papelera de WordPress. Se pueden restaurar con "Deshacer" desde el Historial.`) : null),
  });
  if (ok) startJob($('#pushBtn').dataset.endpoint, $('#pushBtn'));
});
$('#forcePullBtn').addEventListener('click', async () => {
  const ok = await confirmModal({
    title: 'Sobrescribir el Excel',
    tone: 'danger',
    okText: 'Sobrescribir',
    body: 'Se reemplazará el Excel con lo que hay hoy en la tienda. Los cambios que no se hayan subido se perderán (OneDrive guarda la versión anterior en su historial).',
  });
  if (ok) startPull(true, $('#forcePullBtn'));
});

// Aviso al terminar una tarea larga, con lo que sigue.
function notifyJobEnd(job) {
  const label = TYPE_LABEL[job.type] || 'Tarea';
  if (job.status === 'error') {
    toast(`${label}: terminó con error. ${job.error || ''}`.trim(), 'error');
    return;
  }
  const step = PUSH_STEP[job.type];
  const pending = step ? step.pending(job.details?.summary || {}) : 0;
  const next = {
    pull: 'El Excel ya tiene lo que hay en la tienda.',
    review: pending ? 'Revisa el resumen y, si todo está bien, confirma la subida.' : 'No hay cambios para subir.',
    'photos-review': pending ? 'Revisa la lista y confirma para subir las fotos.' : 'No hay fotos nuevas para subir.',
    push: 'Los cambios ya están en la tienda. Revisa el resultado de cada fila.',
    photos: 'Las fotos ya están en la tienda y las carpetas se movieron a "Subidas".',
    undo: 'La tienda quedó como antes de ese push.',
    'attrs-review': pending ? 'Revisa la lista y confirma para corregir los atributos.' : 'Todos los productos variables ya cumplen la regla.',
    'attrs-fix': 'Los atributos ya están corregidos. Haz "Traer de la tienda" para poner el Excel al día.',
  }[job.type] || '';
  toast(`${label}: terminado. ${next}`.trim(), 'success');
}

function startPolling(lane = activeLane) {
  if (watchers[lane]) return; // ya se está vigilando
  let failures = 0;
  const stop = () => { clearInterval(watchers[lane]); delete watchers[lane]; };
  watchers[lane] = setInterval(async () => {
    try {
      const { current } = await api(`/sync/current?lane=${lane}`, { quiet: true });
      if (failures >= 2) toast('Conexión recuperada.', 'success');
      failures = 0;
      if (activeLane === lane) renderJob(current);
      if (current?.status !== 'running') {
        stop();
        if (current) notifyJobEnd(current);
        // Si su pestaña está a la vista, se pone al día.
        const visible = $('#tabs button.active')?.dataset.tab;
        if (lane === 'photos' && visible === 'photos') loadPhotos().catch(() => {});
        if (lane === 'excel' && visible === 'sync') loadSync().catch(() => {});
      }
    } catch (error) {
      if (error.status === 401) return stop();
      failures += 1;
      // La tarea sigue en el servidor aunque se pierda la conexión: se sigue consultando.
      if (failures === 2) toast('Se perdió la conexión con el servidor. La tarea sigue corriendo; reintentando…', 'warning');
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
    $('#attrsReviewBtn').disabled = running;
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
  $('#rowHead').textContent = job.type.startsWith('photos') ? 'Carpeta' : job.type.startsWith('attrs') ? 'ID' : 'Fila';
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
    const tag = i.replaces ? ['convert', 'Convertir'] : [i.kind, { create: 'Nuevo', link: 'Ya existe', delete: 'Eliminar' }[i.kind] || 'Cambio'];
    return el('tr', {},
      el('td', {}, String(i.row)),
      el('td', {},
        el('span', { class: `tag ${tag[0]}` }, tag[1]),
        `${i.type || ''} · `, el('strong', {}, i.sku || '(sin SKU)'),
        el('div', { class: 'muted' }, [i.name, i.attributes].filter(Boolean).join(' · '))),
      el('td', {}, what),
      results.size ? el('td', { class: r ? (r.ok ? '' : 'err') : 'muted' }, r ? [`${r.ok ? '✔' : '✖'} ${r.message}${r.newId ? ` (ID ${r.newId})` : ''}`, productLinks(r)] : '—') : null,
    );
  });
  if (visible.length > MAX_PLAN_ROWS) rows.push(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, `… y ${visible.length - MAX_PLAN_ROWS} filas más (ver la columna "Resultado último push" del Excel).`)));
  if (!visible.length) rows.push(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Nada que mostrar con este filtro.')));
  $('#planBody').replaceChildren(...rows);
}

// Enlaces para consultar en la tienda lo que se creó o modificó.
const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
function productLinks({ url, adminUrl }) {
  if (!url && !adminUrl) return null;
  return el('div', { class: 'links' }, url ? link(url, 'Ver en tienda') : null, url && adminUrl ? ' · ' : null, adminUrl ? link(adminUrl, 'Editar en WordPress') : null);
}

// ---------- tablero de fotos ----------
let dashData = null;
let dashTimer = null;

async function loadPhotos() {
  if (!dashData) {
    $('#dashWarnings').replaceChildren(loadingRow(3, 'Cargando el tablero de fotos…'));
    $('#dashPending').replaceChildren(loadingRow(4));
  }
  const { dashboard, refreshing, current } = await api('/sync/photos/dashboard');
  renderJob(current);
  if (current?.status === 'running') startPolling();
  dashData = dashboard;
  renderDashboard(refreshing);
  if (!dashboard && !refreshing) await refreshDashboard();
  else if (refreshing) watchDashboard();
}

async function refreshDashboard() {
  try {
    await api('/sync/photos/dashboard/refresh', { method: 'POST', body: {} });
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  renderDashboard(true);
  watchDashboard();
}

function watchDashboard() {
  clearInterval(dashTimer);
  dashTimer = setInterval(async () => {
    const res = await api('/sync/photos/dashboard', { quiet: true }).catch(() => null);
    if (!res || res.refreshing) return; // sin conexión o todavía calculando: se vuelve a preguntar
    clearInterval(dashTimer);
    dashData = res.dashboard;
    renderDashboard(false);
    if (dashData?.error) toast(`El tablero no se pudo actualizar: ${dashData.error}`, 'error');
    else toast('Tablero de fotos actualizado.', 'success');
  }, 3000);
}
$('#dashRefreshBtn').addEventListener('click', refreshDashboard);
['#dashSearch', '#dashOnlyPublished', '#dashOnlyMissing'].forEach((sel) => $(sel).addEventListener('input', () => renderNoPhotos()));

function renderDashboard(refreshing) {
  const d = dashData;
  $('#dashRefreshBtn').disabled = refreshing;
  $('#dashRefreshBtn').replaceChildren(...(refreshing ? [spinner(), 'Actualizando… (puede tardar unos minutos)'] : ['Actualizar tablero']));
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
  renderWarnings();
  $('#dashPending').replaceChildren(...(d.pending.items.length
    ? d.pending.items.map((i) => el('tr', {}, el('td', { class: 'muted' }, i.path), el('td', {}, el('strong', {}, i.sku), el('div', { class: 'muted' }, i.name || '')), el('td', {}, String(i.fotos)),
      el('td', { class: i.ok ? '' : 'err' }, i.estado, i.linked
        ? el('div', { class: 'muted' }, `Relacionada a mano con ${i.linked.sku}${i.linked.by ? ` por ${i.linked.by}` : ''}. `,
          el('button', { class: 'link', onclick: () => unlinkFolder(i.folderId, i.path) }, 'Quitar relación'))
        : null)))
    : [none(4, 'No hay carpetas pendientes.')]));
  $('#dashRecent').replaceChildren(...(d.subidas.recientes.length
    ? d.subidas.recientes.map((r) => el('tr', {}, el('td', {}, r.sku), el('td', {}, String(r.fotos)), el('td', {}, fmtDate(r.fecha)), el('td', {}, r.usuario || '—')))
    : [none(4, 'Todavía no se han subido fotos desde el panel.')]));
  renderNoPhotos();
}

// ---------- carpetas con problemas ----------
// Tipos de aviso (los manda el recorrido de carpetas) en el orden en que se muestran.
const WARN_KIND = {
  unmatched: { label: 'Sin SKU', tone: 'err', fix: null },
  'link-broken': { label: 'Relación rota', tone: 'err', fix: null },
  duplicate: { label: 'SKU en 2 carpetas', tone: 'warn', fix: 'Junta las fotos en una sola carpeta en OneDrive.' },
  unsupported: { label: 'Formato no compatible', tone: 'warn', fix: 'Convierte esas fotos a JPG o WEBP en OneDrive.' },
  root: { label: 'Fotos sueltas', tone: 'warn', fix: 'Muévelas dentro de una carpeta con el SKU.' },
  empty: { label: 'Carpeta vacía', tone: 'muted', fix: 'Agrega las fotos o borra la carpeta.' },
  other: { label: 'Otro', tone: 'muted', fix: null },
};
const kindOf = (w) => (WARN_KIND[w.kind] ? w.kind : 'other');
let warnFilter = 'all';
const linkDrafts = new Map(); // lo que se lleva escrito en cada carpeta, para no perderlo al filtrar
$('#warnSearch').addEventListener('input', () => renderWarnings());
$('#tileBlockedBtn').addEventListener('click', () => $('#dashWarningsCard').scrollIntoView({ behavior: 'smooth', block: 'start' }));

// "F.S. Dama/F.S. Vestidos/vestido flores" -> nombre de la carpeta + dónde está.
function folderCell(path) {
  const parts = String(path).split('/');
  return el('td', { class: 'folder-cell' }, el('strong', {}, parts.at(-1)), parts.length > 1 ? el('div', { class: 'muted small' }, parts.slice(0, -1).join(' › ')) : null);
}

function renderWarnings() {
  const avisos = dashData?.avisos || [];
  const counts = avisos.reduce((m, w) => m.set(kindOf(w), (m.get(kindOf(w)) || 0) + 1), new Map());
  if (warnFilter !== 'all' && !counts.has(warnFilter)) warnFilter = 'all';
  const chip = (key, label, n) => el('button', {
    type: 'button',
    class: `chip${warnFilter === key ? ' active' : ''}`,
    'aria-pressed': String(warnFilter === key),
    onclick: () => { warnFilter = key; renderWarnings(); },
  }, `${label} (${n})`);
  $('#warnFilters').replaceChildren(
    chip('all', 'Todos', avisos.length),
    ...Object.entries(WARN_KIND).filter(([k]) => counts.has(k)).map(([k, v]) => chip(k, v.label, counts.get(k))),
  );
  const actionable = (counts.get('unmatched') || 0) + (counts.get('link-broken') || 0);
  $('#dashWarningsInfo').textContent = avisos.length ? `${avisos.length} aviso(s)${actionable ? ` · ${actionable} se pueden relacionar aquí` : ''}` : '';

  const q = $('#warnSearch').value.trim().toLowerCase();
  const order = Object.keys(WARN_KIND);
  const list = avisos
    .filter((w) => (warnFilter === 'all' || kindOf(w) === warnFilter) && (!q || `${w.path} ${w.message} ${w.linked?.sku || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || a.path.localeCompare(b.path, 'es', { numeric: true, sensitivity: 'base' }));
  const rows = list.slice(0, 300).map((w) => {
    const kind = WARN_KIND[kindOf(w)];
    let action = el('span', { class: 'muted' }, kind.fix || '—');
    if (w.unmatched && w.folderId) action = linkForm(w);
    else if (w.linked && w.folderId) {
      action = el('div', {}, el('span', { class: 'muted' }, `${kind.fix} O quita la relación manual de "${w.linkedPath}". `),
        el('button', { type: 'button', class: 'small secondary', onclick: () => unlinkFolder(w.folderId, w.linkedPath) }, 'Quitar relación'));
    }
    return el('tr', {},
      folderCell(w.path),
      el('td', {}, el('span', { class: `tag ${kind.tone}` }, kind.label), el('div', { class: 'muted small' }, w.message)),
      el('td', { class: 'action-cell' }, action));
  });
  if (list.length > 300) rows.push(el('tr', {}, el('td', { colspan: 3, class: 'muted' }, `… y ${list.length - 300} más (usa el buscador o los filtros).`)));
  if (!list.length) rows.push(el('tr', {}, el('td', { colspan: 3, class: 'muted' }, avisos.length ? 'Nada con este filtro.' : 'Sin problemas en las carpetas pendientes.')));
  $('#dashWarnings').replaceChildren(...rows);
}

// Carpeta cuyo nombre no coincide con ningún SKU: se relaciona a mano escribiendo el SKU.
function linkForm(w) {
  const input = el('input', { type: 'text', placeholder: 'SKU o estilo+color', autocomplete: 'off', spellcheck: 'false', 'aria-label': `SKU para la carpeta ${w.path}` });
  input.value = linkDrafts.get(w.folderId) || '';
  const error = el('span', { class: 'field-error', role: 'alert' });
  const button = el('button', { type: 'submit', class: 'small' }, 'Relacionar');
  input.addEventListener('input', () => {
    linkDrafts.set(w.folderId, input.value);
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  });
  const fail = (message) => {
    error.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  const form = el('form', { class: 'link-form', novalidate: '', onsubmit: (e) => { e.preventDefault(); linkFolder(w, input, button, fail); } },
    el('div', { class: 'link-row' }, input, button,
      w.linked ? el('button', { type: 'button', class: 'small secondary', onclick: () => unlinkFolder(w.folderId, w.path) }, 'Quitar relación') : null),
    error);
  return form;
}

async function linkFolder(w, input, button, fail) {
  const problem = validateSku(input.value);
  if (problem) return fail(problem);
  const sku = input.value.trim().toUpperCase();
  let target;
  input.readOnly = true;
  try {
    ({ target } = await busy(button, 'Buscando…', () => api('/sync/photos/links/check', { method: 'POST', body: { sku } })));
  } catch (error) {
    return fail(error.message); // ej. "no coincide con ningún SKU": se corrige ahí mismo
  } finally {
    input.readOnly = false;
  }

  const done = await openModal({
    title: 'Relacionar carpeta',
    okText: 'Relacionar',
    body: el('div', {},
      el('p', {}, 'Las fotos de esta carpeta se subirán a este producto en la siguiente revisión de fotos.'),
      facts([['Carpeta', w.path], ['Fotos', w.fotos ? String(w.fotos) : null], ['SKU', target.label], ['Producto', target.name], ['Tipo', target.type]])),
    onSubmit: () => api('/sync/photos/links', { method: 'POST', body: { folderId: w.folderId, folderPath: w.path, sku } }),
  });
  if (!done) return;
  linkDrafts.delete(w.folderId);
  // Sale de la lista al momento; pasa a "Carpetas pendientes" cuando termine de actualizarse el tablero.
  if (dashData?.avisos) dashData.avisos = dashData.avisos.filter((a) => a.folderId !== w.folderId || !(a.unmatched || a.kind === 'link-broken'));
  toast(`Carpeta relacionada con ${target.label}. Sale de esta lista y aparecerá en "Carpetas pendientes" cuando termine de actualizarse el tablero.`, 'success');
  renderDashboard(true);
  watchDashboard();
}

async function unlinkFolder(folderId, path) {
  const done = await openModal({
    title: 'Quitar relación',
    tone: 'warning',
    okText: 'Quitar relación',
    body: el('div', {}, el('p', {}, 'La carpeta volverá a aparecer como "Sin SKU" y sus fotos no se subirán hasta relacionarla de nuevo.'), facts([['Carpeta', path]])),
    onSubmit: () => api(`/sync/photos/links/${encodeURIComponent(folderId)}`, { method: 'DELETE' }),
  });
  if (!done) return;
  toast('Relación quitada. El tablero se está actualizando.', 'success');
  renderDashboard(true);
  watchDashboard();
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

// ---------- variantes sueltas ----------
let orphData = null;
let orphTimer = null;

async function loadOrphans() {
  if (!orphData) $('#orphBody').replaceChildren(loadingRow(2, 'Cargando el reporte…'));
  const { report, refreshing } = await api('/sync/orphans');
  orphData = report;
  renderOrphans(refreshing);
  if (!report && !refreshing) await refreshOrphans();
  else if (refreshing) watchOrphans();
}

async function refreshOrphans() {
  try {
    await api('/sync/orphans/refresh', { method: 'POST', body: {} });
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  renderOrphans(true);
  $('#orphBody').replaceChildren(loadingRow(2, 'Leyendo todos los productos de la tienda… puede tardar unos minutos.'));
  watchOrphans();
}

function watchOrphans() {
  clearInterval(orphTimer);
  orphTimer = setInterval(async () => {
    const res = await api('/sync/orphans', { quiet: true }).catch(() => null);
    if (!res || res.refreshing) return;
    clearInterval(orphTimer);
    orphData = res.report;
    renderOrphans(false);
    if (orphData?.error) toast(`El reporte no se pudo generar: ${orphData.error}`, 'error');
    else toast('Reporte de variantes sueltas actualizado.', 'success');
  }, 3000);
}
$('#orphRefreshBtn').addEventListener('click', refreshOrphans);
$('#orphSearch').addEventListener('input', () => renderOrphans(false));

function renderOrphans(refreshing) {
  const d = orphData;
  $('#orphRefreshBtn').disabled = refreshing;
  $('#orphRefreshBtn').replaceChildren(...(refreshing ? [spinner(), 'Actualizando… (puede tardar unos minutos)'] : ['Actualizar reporte']));
  $('#orphUpdated').textContent = d?.updatedAt ? `Actualizado ${fmtDate(d.updatedAt)}` : '';
  $('#orphError').classList.toggle('hidden', !d?.error);
  $('#orphError').textContent = d?.error || '';
  if (!d?.groups) return;

  $('#orphStyles').textContent = d.totals.estilos;
  $('#orphProducts').textContent = d.totals.productos;
  $('#orphWithParent').textContent = d.totals.conPadreVariable;
  const q = $('#orphSearch').value.trim().toLowerCase();
  const list = d.groups.filter((g) => !q || [g.style, g.parent?.name, ...g.items.flatMap((i) => [i.sku, i.name])].join(' ').toLowerCase().includes(q));
  const rows = list.slice(0, 300).map((g) => el('tr', {},
    el('td', {},
      el('strong', {}, g.style),
      el('div', { class: g.parent ? 'muted' : 'conf' }, g.parent
        ? [`Padre ${g.parent.type}: `, g.parent.url ? link(g.parent.url, g.parent.name) : g.parent.name, g.parent.type === 'Simple' ? ' (cámbialo a Variable)' : '']
        : `Sin padre: agrega una fila Variable con SKU ${g.style}`)),
    el('td', {}, el('ul', { class: 'orph-items' }, g.items.map((i) => el('li', {},
      i.url ? link(i.url, i.sku) : i.sku, ` · talla ${i.talla} · color ${i.color} · ${i.status}`,
      el('span', { class: 'muted' }, ` — ${i.name}`)))))));
  if (list.length > 300) rows.push(el('tr', {}, el('td', { colspan: 2, class: 'muted' }, `… y ${list.length - 300} estilos más (usa el buscador).`)));
  if (!list.length) rows.push(el('tr', {}, el('td', { colspan: 2, class: 'muted' }, 'Nada que mostrar.')));
  $('#orphBody').replaceChildren(...rows);
}

// ---------- historial ----------
async function loadHistory() {
  $('#runsBody').replaceChildren(loadingRow(5, 'Cargando historial…'));
  let runs;
  try {
    ({ runs } = await api('/sync/runs'));
  } catch (error) {
    $('#runsBody').replaceChildren(messageRow(5, `No se pudo cargar el historial: ${error.message}`, 'err'));
    return;
  }
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
  const ok = await confirmModal({
    title: `Deshacer el push #${runId}`,
    tone: 'warning',
    okText: 'Deshacer',
    body: el('div', {},
      el('p', {}, 'La tienda vuelve a como estaba antes de ese push:'),
      el('ul', { class: 'plain-list' },
        el('li', {}, 'Los productos que cambió regresan a sus valores anteriores.'),
        el('li', {}, 'Lo que creó se borra (si nadie lo modificó después).'),
        el('li', {}, 'Lo que mandó a la papelera se restaura.')),
      el('p', { class: 'muted' }, 'Nunca se pisa un cambio hecho después del push. Las filas afectadas del Excel se actualizan solas.')),
  });
  if (!ok) return;
  switchTab('sync');
  launch(null, () => api(`/sync/runs/${runId}/undo`, { method: 'POST', body: {} }));
}

async function toggleChanges(runId, row, button) {
  if (row.nextSibling?.classList?.contains('run-detail')) {
    row.nextSibling.remove();
    button.textContent = button.textContent.replace('Ocultar', 'Ver');
    return;
  }
  let changes;
  try {
    ({ changes } = await busy(button, 'Cargando…', () => api(`/sync/runs/${runId}/changes`)));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  const table = el('table', { class: 'small-table' },
    el('tr', {}, ['SKU', 'Campo', 'Antes', 'Después', 'Resultado'].map((h) => el('th', {}, h))),
    changes.map((c) => el('tr', {},
      el('td', {}, c.url ? link(c.url, c.sku || `ID ${c.woo_id}`) : c.sku || `ID ${c.woo_id}`),
      el('td', {}, c.field),
      el('td', { class: 'muted' }, c.old_value ?? '(vacío)'),
      el('td', {}, c.new_value ?? '(vacío)'),
      el('td', { class: c.result === 'ok' ? '' : 'err' }, c.result === 'ok' ? '✔' : `✖ ${c.error || ''}`))));
  row.after(el('tr', { class: 'run-detail' }, el('td', { colspan: 5 }, table)));
  button.textContent = button.textContent.replace('Ver', 'Ocultar');
}

// ---------- usuarios ----------
let roles = [];
async function loadUsers({ quiet = false } = {}) {
  if (!quiet) $('#usersBody').replaceChildren(loadingRow(7, 'Cargando usuarios…'));
  const data = await api('/users');
  roles = data.roles;
  $('#roleSelect').replaceChildren(...roles.map((r) => el('option', { value: r.key }, r.label)));
  $('#rolesHelp').replaceChildren(
    ...roles.map((r) => el('li', {}, el('strong', {}, `${r.label}: `), describePerms(r.can))),
    el('li', {}, el('strong', {}, 'Permisos extra: '), `se dan o quitan a cada usuario en la columna "Permisos extra" (${data.grantable.map((g) => g.label.toLowerCase()).join('; ')}). El administrador los tiene todos.`),
  );

  // Casillas de permisos extra: cada cambio guarda la lista completa del usuario.
  const permsCell = (u) => {
    if (u.role === 'admin') return el('span', { class: 'muted' }, 'Todos');
    const boxes = data.grantable.map((g) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = u.extraPermissions.includes(g.key);
      return [g.key, box, el('label', { class: 'check' }, box, g.label)];
    });
    boxes.forEach(([, box]) => box.addEventListener('change', () => updateUser(u.id, { permissions: boxes.filter(([, b]) => b.checked).map(([key]) => key) }, `Permisos de ${u.displayName} actualizados.`, box)));
    return el('div', { class: 'perm-list' }, boxes.map(([, , label]) => label));
  };

  $('#usersBody').replaceChildren(...data.users.map((u) => {
    const roleSelect = el('select', { 'aria-label': `Perfil de ${u.displayName}`, onchange: (e) => updateUser(u.id, { role: e.target.value }, `Perfil de ${u.displayName} actualizado.`, e.target) },
      roles.map((r) => {
        const opt = el('option', { value: r.key }, r.label);
        if (r.key === u.role) opt.selected = true;
        return opt;
      }));
    return el('tr', { class: u.active ? '' : 'inactive' },
      el('td', {}, u.displayName),
      el('td', {}, u.username),
      el('td', {}, roleSelect),
      el('td', {}, permsCell(u)),
      el('td', {}, fmtDate(u.lastLoginAt)),
      el('td', {}, u.active ? 'Activo' : 'Desactivado'),
      el('td', {},
        el('button', { class: 'small secondary', onclick: (e) => toggleActive(u, e.currentTarget) }, u.active ? 'Desactivar' : 'Activar'),
        ' ',
        el('button', { class: 'small secondary', onclick: () => resetPassword(u) }, 'Contraseña')),
    );
  }));
}

function describePerms(perms) {
  const labels = { pull: 'traer de la tienda', 'pull:force': 'sobrescribir el Excel', push: 'subir a la tienda', create: 'crear productos', photos: 'subir fotos', undo: 'deshacer el último push', history: 'ver historial', users: 'administrar usuarios', connections: 'administrar conexiones', delete: 'eliminar productos', orphans: 'reporte de variantes sueltas', attributes: 'corregir atributos' };
  return perms.map((p) => labels[p] || p).join(', ');
}

// Guarda un cambio de un usuario. Mientras tanto se desactivan los controles de
// su fila (para no mandar dos cambios encimados) y al final se recarga la tabla.
async function updateUser(id, changes, success = 'Cambios guardados.', control = null) {
  const row = control?.closest('tr');
  const controls = row ? [...row.querySelectorAll('input, select, button')] : [];
  controls.forEach((c) => { c.disabled = true; });
  row?.classList.add('saving');
  try {
    await api(`/users/${id}`, { method: 'PATCH', body: changes });
    toast(success, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
  await loadUsers({ quiet: true }).catch((error) => toast(error.message, 'error'));
}

async function toggleActive(user, button) {
  if (user.active) {
    const ok = await confirmModal({
      title: 'Desactivar usuario',
      tone: 'danger',
      okText: 'Desactivar',
      body: `${user.displayName} ya no podrá entrar al panel y se cerrarán sus sesiones al instante. Se puede volver a activar cuando quieras.`,
    });
    if (!ok) return;
  }
  updateUser(user.id, { active: !user.active }, user.active ? `${user.displayName} quedó desactivado.` : `${user.displayName} quedó activo.`, button);
}

async function resetPassword(user) {
  const done = await openModal({
    title: `Nueva contraseña para ${user.displayName}`,
    okText: 'Guardar',
    fields: [
      { name: 'password', label: 'Nueva contraseña (mínimo 8 caracteres)', type: 'password', autocomplete: 'new-password', validate: validateNewPassword },
      { name: 'again', label: 'Repítela', type: 'password', autocomplete: 'new-password', validate: validateRepeat('password') },
    ],
    onSubmit: ({ password }) => api(`/users/${user.id}`, { method: 'PATCH', body: { password } }),
  });
  if (done) toast(`Contraseña de ${user.displayName} actualizada. Compártela por un medio seguro.`, 'success');
}

const USERNAME_FORMAT = /^[a-z0-9._-]{3,40}$/i;
$('#newUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formEl = e.target;
  const form = Object.fromEntries(new FormData(formEl));
  $('#newUserMsg').textContent = '';
  const valid = showFieldErrors(formEl, {
    displayName: form.displayName.trim() ? '' : 'Escribe el nombre.',
    username: !form.username.trim() ? 'Escribe el usuario.' : USERNAME_FORMAT.test(form.username.trim()) ? '' : 'De 3 a 40 caracteres: letras, números, punto, guion o guion bajo.',
    password: validateNewPassword(form.password),
    role: form.role ? '' : 'Elige un perfil.',
  });
  if (!valid) return;
  try {
    await busy(formEl.querySelector('button[type="submit"]'), 'Creando…',
      () => api('/users', { method: 'POST', body: { ...form, username: form.username.trim(), displayName: form.displayName.trim() } }));
    toast(`Usuario ${form.username.trim()} creado.`, 'success');
    formEl.reset();
    loadUsers({ quiet: true }).catch((error) => toast(error.message, 'error'));
  } catch (error) {
    $('#newUserMsg').textContent = error.message;
  }
});
$('#newUserForm').addEventListener('input', (e) => {
  const span = e.target.form?.querySelector(`[data-for="${e.target.name}"]`);
  if (span) span.textContent = '';
  e.target.removeAttribute('aria-invalid');
});

// ---------- conexiones ----------
async function loadConnections() {
  $('#onedriveStatus').replaceChildren(spinner(), ' Comprobando la conexión con OneDrive…');
  $('#wooStatus').replaceChildren(spinner(), ' Comprobando la conexión con la tienda…');
  let data;
  try {
    data = await api('/connections');
  } catch (error) {
    $('#onedriveStatus').textContent = `No se pudo comprobar: ${error.message}`;
    $('#wooStatus').textContent = '';
    return;
  }
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

$('#onedriveConnectBtn').addEventListener('click', async (e) => {
  try {
    const { code } = await busy(e.currentTarget, 'Pidiendo código…', () => api('/connections/onedrive/connect', { method: 'POST', body: {} }));
    showCode(code);
    toast('Sigue los pasos del recuadro para conectar la cuenta de Microsoft.', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
});

$('#onedriveDisconnectBtn').addEventListener('click', async () => {
  const done = await openModal({
    title: 'Desconectar OneDrive',
    tone: 'danger',
    okText: 'Desconectar',
    body: 'El panel dejará de poder leer y escribir el Excel y las fotos hasta que alguien lo vuelva a conectar.',
    onSubmit: () => api('/connections/onedrive/disconnect', { method: 'POST', body: {} }),
  });
  if (!done) return;
  toast('OneDrive desconectado.', 'success');
  loadConnections();
});

// ---------- arranque ----------
// Pantalla de carga mientras se comprueba la sesión; si el servidor no responde, se puede reintentar.
async function boot() {
  $('#bootMessage').textContent = 'Comprobando tu sesión…';
  $('#bootSpinner').classList.remove('hidden');
  $('#bootRetry').classList.add('hidden');
  try {
    const data = await api('/auth/me');
    me = data.user;
    showApp();
  } catch (error) {
    if (error.status === 401) return showLogin();
    $('#bootSpinner').classList.add('hidden');
    $('#bootMessage').textContent = error.message;
    $('#bootRetry').classList.remove('hidden');
  }
}
$('#bootRetry').addEventListener('click', boot);
boot();
