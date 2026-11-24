const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotices } = require('../src/server/activity');

const at = '2026-11-24T10:32:00-06:00';
const runs = [
  { id: 1, type: 'push', finished_at: at, user_name: 'Ana', summary: { 'Guardados correctamente': 7, 'Enviados a la papelera': 1 }, new_skus: ['RD49321', 'RD49321OS004'] },
  { id: 2, type: 'push', finished_at: at, user_name: 'Ana', summary: { 'Guardados correctamente': 3 }, new_skus: null },
  { id: 3, type: 'photos', finished_at: at, user_name: 'Luis', summary: { 'Productos/colores con fotos asignadas': 12 } },
  { id: 4, type: 'pull', finished_at: at, user_name: 'Ana', summary: {} },
  { id: 5, type: 'undo', finished_at: at, user_name: 'Ana', summary: {} },
  { id: 6, type: 'merge', finished_at: at, user_name: 'Edgar', summary: { 'Estilos corregidos': 18 } },
  { id: 7, type: 'review', finished_at: at, user_name: 'Ana', summary: {} },
];
const ids = (list) => list.map((n) => n.id);

test('Fotos: solo productos nuevos y modelos juntados', () => {
  const notices = buildNotices(runs, 'fotos');
  assert.deepEqual(ids(notices), ['1', '6']);
  assert.match(notices[0].text, /Ana subió 2 producto\(s\)\/variación\(es\) nuevos.*revisa si tienen fotos/);
  assert.deepEqual(notices[0].skus, ['RD49321', 'RD49321OS004']);
});

test('Catálogo: cambios que dejan vieja la revisión, fotos y traer', () => {
  const notices = buildNotices(runs, 'excel');
  assert.deepEqual(ids(notices), ['1', '2', '3', '4', '5', '6']);
  assert.match(notices[0].text, /7 guardado\(s\), 1 a la papelera, 2 nuevo\(s\).*revisión pendiente/);
  assert.equal(notices[0].tone, 'warning');
  assert.deepEqual(notices[1].skus, [], 'sin productos nuevos no lista SKUs');
  assert.match(notices[2].text, /Luis subió fotos de 12/);
});

test('las revisiones no generan avisos y un perfil desconocido no recibe nada', () => {
  assert.ok(!ids(buildNotices(runs, 'admin')).includes('7'));
  assert.deepEqual(buildNotices(runs, 'otro'), []);
});

test('la lista de SKUs se corta y dice cuántos más hay', () => {
  const many = Array.from({ length: 20 }, (_, i) => `RD${10000 + i}`);
  const [notice] = buildNotices([{ id: 9, type: 'push', finished_at: at, user_name: 'Ana', summary: {}, new_skus: many }], 'fotos');
  assert.equal(notice.skus.length, 15);
  assert.equal(notice.moreSkus, 5);
});
