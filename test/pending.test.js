const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingStore } = require('../src/server/pending');

test('Revisiones por usuario: la de uno no borra la de otro', () => {
  const p = pendingStore();
  p.set(1, 'revisión de Ana');
  p.set(2, 'revisión de Juan');
  assert.equal(p.take(1), 'revisión de Ana');
  assert.equal(p.take(1), null, 'solo se usa una vez');
  assert.equal(p.take(2), 'revisión de Juan');
  assert.equal(p.missingMessage(1, 'Revisar cambios'), 'Primero haz "Revisar cambios".');
});

test('Cuando alguien sube, las revisiones de los demás se descartan y se explica por qué', () => {
  const p = pendingStore();
  p.set(1, 'a');
  p.set(2, 'b');
  p.invalidate('Ana subió cambios a la tienda');
  assert.equal(p.take(2), null);
  assert.match(p.missingMessage(2, 'Revisar cambios'), /Ana subió cambios a la tienda después de que revisaste/);
  p.set(2, 'nueva');
  assert.equal(p.missingMessage(2, 'Revisar cambios'), 'Primero haz "Revisar cambios".', 'una revisión nueva borra el aviso');
  assert.equal(p.take(2), 'nueva');
});
