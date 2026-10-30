// Ritmo de las peticiones a la tienda (WooCommerce y WordPress). El hosting
// corta con 429 ("demasiadas peticiones") si llegan muchas seguidas: aquí se
// espacian y, si aun así pide esperar, se pausa TODO el proceso (no solo esa
// petición) el tiempo que indique, y luego se sigue sin marcar error.
const config = require('../config');

// Directo al servidor (WOO_ORIGIN_IP) no hay límite del CDN y se puede ir más rápido.
const MIN_INTERVAL_MS = process.env.WOO_MIN_INTERVAL_MS ? Number(process.env.WOO_MIN_INTERVAL_MS) : (config.woo.originIp ? 250 : 800);
const PAUSES_S = [30, 60, 120, 240, 300]; // si el hosting no dice cuánto esperar
const MAX_PAUSE_S = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
let pausedUntil = 0;
const listeners = new Set();

// Las tareas en curso se suscriben para que su Detalle diga por qué está esperando.
const onPause = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function waitTurn() {
  for (;;) {
    const wait = Math.max(pausedUntil, nextSlot) - Date.now();
    if (wait <= 0) {
      nextSlot = Date.now() + MIN_INTERVAL_MS;
      return;
    }
    await sleep(wait);
  }
}

function pause(seconds, details) {
  console.error(`[429] ${details}`); // queda en pm2 logs aunque nadie tenga la tarea a la vista
  const until = Date.now() + seconds * 1000;
  if (until <= pausedUntil) return; // otra petición ya pausó igual o más
  pausedUntil = until;
  for (const fn of listeners) fn(`La tienda pidió bajar el ritmo (429). Esperando ${seconds} s y se continúa… (${details})`);
}

// Quién respondió el 429 (CDN de Hostinger, Cloudflare, Wordfence, LiteSpeed…),
// para poder reclamarlo con datos. La URL va sin parámetros: llevan las llaves de WooCommerce.
const TRACE_HEADERS = ['server', 'platform', 'retry-after', 'x-hcdn-request-id', 'cf-ray'];
function describeLimit({ method, url, headers, body }) {
  const header = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]) ?? null;
  const parts = [[method && String(method).toUpperCase(), String(url || '').split('?')[0]].filter(Boolean).join(' ')];
  for (const k of TRACE_HEADERS) if (header(k)) parts.push(`${k}: ${header(k)}`);
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  parts.push(text && text !== '""' ? `respuesta: ${text}` : 'respuesta vacía');
  return parts.join(' · ');
}

// Retry-After puede venir en segundos o como fecha.
function retryAfterSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  const s = Number.isFinite(n) ? n : Math.round((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), MAX_PAUSE_S) : null;
}

/**
 * Ejecuta `fn` a su turno. `inspect(result, error)` devuelve { limited, retryAfter, details }:
 * si la tienda respondió 429 se pausa todo y se repite (hasta 5 veces).
 */
async function run(fn, inspect) {
  for (let attempt = 0; ; attempt += 1) {
    await waitTurn();
    let result;
    let error;
    try {
      result = await fn();
    } catch (e) {
      error = e;
    }
    const { limited, retryAfter, details } = await inspect(result, error);
    if (!limited || attempt >= PAUSES_S.length) {
      if (limited) console.error(`[429] Se dejó de reintentar: ${details}`);
      if (error) {
        if (limited) error.message = `${error.message} (la tienda siguió bloqueando tras ${PAUSES_S.length} pausas) — ${details}`;
        throw error;
      }
      return result;
    }
    pause(retryAfterSeconds(retryAfter) ?? PAUSES_S[attempt], details);
  }
}

// Para axios (cliente de WooCommerce): el 429 llega como error.
const axiosCall = (fn) => run(fn, (_res, error) => {
  const r = error?.response;
  if (r?.status !== 429) return { limited: false };
  return {
    limited: true,
    retryAfter: r.headers?.['retry-after'],
    details: describeLimit({ method: error.config?.method, url: error.config?.url, headers: r.headers, body: r.data }),
  };
});

// Para fetch (subida de fotos a WordPress): el 429 llega como respuesta. El
// cuerpo se lee de una copia para que quien llamó todavía pueda leerlo.
const fetchCall = (fn) => run(fn, async (res) => {
  if (res?.status !== 429) return { limited: false };
  const body = typeof res.clone === 'function' ? await res.clone().text().catch(() => '') : '';
  return {
    limited: true,
    retryAfter: res.headers?.get('retry-after'),
    details: describeLimit({ method: 'POST', url: res.url, headers: res.headers, body }),
  };
});

module.exports = { axiosCall, fetchCall, onPause, retryAfterSeconds, describeLimit };
