const test = require('node:test');
const assert = require('node:assert/strict');
const throttle = require('../src/woo/throttle');

// Respuesta de fetch con Retry-After de 1 s para que la prueba no tarde.
const limited = () => ({ status: 429, ok: false, headers: new Map([['retry-after', '1']]) });
const ok = () => ({ status: 201, ok: true, headers: new Map() });

test('429: pausa lo que pide la tienda y repite sin marcar error', async () => {
  const messages = [];
  const stop = throttle.onPause((m) => messages.push(m));
  let calls = 0;
  const started = Date.now();
  const res = await throttle.fetchCall(async () => { calls += 1; return calls < 3 ? limited() : ok(); });
  stop();
  assert.equal(res.status, 201);
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 1900, 'esperó el Retry-After en cada 429');
  assert.match(messages[0], /bajar el ritmo/);
});

test('429 en axios: también se repite; otros errores se lanzan', async () => {
  let calls = 0;
  const err429 = Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '1' } } });
  const res = await throttle.axiosCall(async () => { calls += 1; if (calls === 1) throw err429; return { data: 'ok' }; });
  assert.equal(res.data, 'ok');
  const err400 = Object.assign(new Error('400'), { response: { status: 400, headers: {} } });
  await assert.rejects(throttle.axiosCall(async () => { throw err400; }), /400/);
});

test('Retry-After en segundos o como fecha', () => {
  assert.equal(throttle.retryAfterSeconds('30'), 30);
  assert.equal(throttle.retryAfterSeconds(null), null);
  const s = throttle.retryAfterSeconds(new Date(Date.now() + 20000).toUTCString());
  assert.ok(s >= 19 && s <= 21);
  assert.equal(throttle.retryAfterSeconds('99999'), 600, 'nunca más de 10 minutos');
});
