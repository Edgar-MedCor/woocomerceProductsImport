// Regla de atributos de la tienda: todos son globales (pa_*) y solo Color y
// Talla se usan para variaciones (Talla no, si su único valor es Unitalla). La aplica el push a cada producto Variable que
// toca y la reparación de atributos a los que ya están en la tienda.
const norm = (s) => String(s || '').trim().toLowerCase();
const plain = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

const VARIATION_ATTRIBUTES = new Set(['color', 'talla']);
const isVariationAttribute = (names) => [].concat(names).some((n) => VARIATION_ATTRIBUTES.has(plain(n)));
const ONE_SIZE = new Set(['unitalla', 'talla unica', 'unica']);
const isOneSize = (options) => (options || []).length > 0 && options.every((o) => ONE_SIZE.has(plain(o)));
const hasColor = (list) => (list || []).some((a) => plain(a.name) === 'color');

// ¿Se usa para variaciones? Color siempre. Talla también, salvo que sea solo
// Unitalla y el producto tenga Color (sin Color, Talla es lo único con qué variar).
function shouldVary(names, options, withColor) {
  const n = [].concat(names).map(plain);
  if (n.includes('color')) return true;
  if (n.includes('talla')) return !(isOneSize(options) && withColor);
  return false;
}

// Atributo global por nombre o slug ("Técnica" = "Tecnica" = pa_tecnica).
function findGlobal(globals, names) {
  const wanted = [].concat(names).map(plain);
  return (globals || []).find((g) => wanted.includes(plain(g.name)) || wanted.includes(plain(String(g.slug || '').replace(/^pa_/, ''))));
}

/**
 * Corrige la configuración de los atributos de un producto Variable.
 * `usedByVariations(attr)` dice si las variaciones se distinguen por ese atributo.
 * Devuelve { attributes, changes: [{ field, from, to }], warnings }.
 */
function applyRule(current, globals, usedByVariations = () => false) {
  const changes = [];
  const warnings = [];
  const withColor = hasColor(current);
  const attributes = (current || []).map((a) => {
    const next = { ...a };
    const forVariations = shouldVary(a.name, a.options, withColor);
    if (forVariations && !a.variation) {
      next.variation = true;
      changes.push({ field: a.name, from: 'No se usa para variaciones', to: 'Se usa para variaciones' });
    }
    if (!forVariations && a.variation) {
      if (usedByVariations(a)) warnings.push(`${a.name} se queda para variaciones porque sus variaciones tienen valores distintos en él. Revísalo a mano.`);
      else {
        next.variation = false;
        changes.push({ field: a.name, from: 'Se usa para variaciones', to: 'No se usa para variaciones' });
      }
    }
    if (!a.id) {
      const glob = findGlobal(globals, a.name);
      // Pasar a global un atributo de variación cambia su clave y las variaciones lo perderían.
      if (next.variation) warnings.push(`${a.name} es local y se usa para variaciones; no se pasa a global para no romper las variaciones.`);
      else if (!glob) warnings.push(`${a.name} es local y no existe un atributo global con ese nombre (créalo en Productos → Atributos).`);
      else {
        next.id = glob.id;
        next.name = glob.name;
        changes.push({ field: a.name, from: 'Local', to: `Global (${glob.name})` });
      }
    }
    return next;
  });
  return { attributes, changes, warnings };
}

// Formato que espera la API de WooCommerce para guardar los atributos de un producto.
const attributePayload = (list) => list.map(({ id, name, options, visible, variation, position }) => (id
  ? { id, options, visible, variation, position }
  : { name, options, visible, variation, position }));

module.exports = { VARIATION_ATTRIBUTES, isVariationAttribute, shouldVary, hasColor, findGlobal, applyRule, attributePayload };
