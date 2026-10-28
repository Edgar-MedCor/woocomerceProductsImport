// Respaldo de un push: justo antes de escribir en la tienda se consulta cómo
// está cada producto/variación que se va a tocar ("before"); después se guarda
// cómo quedó ("after"). Con eso "Deshacer" sabe qué restaurar y detecta si
// alguien volvió a cambiar algo después del push.
const store = require('../woo/store');
const { ATTRIBUTE_COLUMNS, META_COLUMNS, TYPE } = require('./fields');

const ATTR_FIELDS = new Set([...ATTRIBUTE_COLUMNS.map((c) => c.key), 'otherAttributes', 'attributes']);
const SIMPLE = {
  type: ['type'], name: ['name'], sku: ['sku'], status: ['status'], featured: ['featured'],
  categories: ['categories'], tags: ['tags'], brand: ['brands'],
  shortDescription: ['short_description'], description: ['description'],
  regularPrice: ['regular_price'], salePrice: ['sale_price'],
  stock: ['manage_stock', 'stock_quantity'], stockStatus: ['stock_status'],
  weight: ['weight'], length: ['dimensions'], width: ['dimensions'], height: ['dimensions'],
};

// Campos de WooCommerce que toca un cambio del Excel.
function wooFields(changeKey, isVariation) {
  if (SIMPLE[changeKey]) return SIMPLE[changeKey];
  if (changeKey === 'images') return [isVariation ? 'image' : 'images'];
  if (ATTR_FIELDS.has(changeKey)) return ['attributes'];
  const meta = META_COLUMNS.find((m) => m.key === changeKey);
  return meta ? [`meta:${meta.meta}`] : [];
}

const ids = (list) => (list || []).map((t) => ({ id: t.id }));

// Valor normalizado de un campo (mismo formato para guardar, comparar y restaurar).
function pick(obj, field) {
  if (!obj) return null;
  if (field.startsWith('meta:')) {
    const key = field.slice(5);
    const entry = (obj.meta_data || []).find((m) => m.key === key);
    return entry ? String(entry.value ?? '') : '';
  }
  switch (field) {
    case 'categories': case 'tags': case 'brands': case 'images':
      return ids(obj[field]);
    case 'image':
      return obj.image?.id ? { id: obj.image.id } : {};
    case 'dimensions':
      return { length: obj.dimensions?.length || '', width: obj.dimensions?.width || '', height: obj.dimensions?.height || '' };
    case 'manage_stock':
      return obj.manage_stock === true; // 'parent' (hereda del padre) se restaura como false
    case 'attributes':
      return (obj.attributes || []).map((a) => ('option' in a
        ? { id: a.id || 0, name: a.name, option: a.option ?? '' }
        : { id: a.id || 0, name: a.name, options: a.options || [], visible: Boolean(a.visible), variation: Boolean(a.variation), position: a.position ?? 0 }));
    default:
      return obj[field] ?? null;
  }
}

// Comparación tolerante (orden de atributos y tipos de números no importan).
function canonical(field, value) {
  if (field === 'attributes' && Array.isArray(value)) {
    return JSON.stringify(value.map((a) => ({ ...a, options: a.options ? [...a.options].map(String).sort() : undefined }))
      .sort((a, b) => `${a.id}${a.name}`.localeCompare(`${b.id}${b.name}`)));
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
const sameValue = (field, a, b) => canonical(field, a) === canonical(field, b);

function snapshotOf(obj, fields) {
  return Object.fromEntries(fields.map((f) => [f, pick(obj, f)]));
}

// Payload para volver a dejar los campos como en `values`.
function toPayload(values, fields) {
  const payload = {};
  const meta = [];
  for (const f of fields) {
    if (f.startsWith('meta:')) meta.push({ key: f.slice(5), value: values[f] ?? '' });
    else payload[f] = values[f];
  }
  if (meta.length) payload.meta_data = meta;
  // Sin control de inventario no se manda cantidad (Woo la ignoraría o fallaría).
  if (payload.manage_stock === false) delete payload.stock_quantity;
  return payload;
}

const liveItems = (plan) => plan.items.filter((i) => !i.errors.length && i.changes.length);

function fieldsOf(item) {
  const isVariation = item.type === TYPE.variation;
  return [...new Set(item.changes.flatMap((c) => wooFields(c.key, isVariation)))];
}

function parentIdOf(item, plan) {
  if (item.parentId) return item.parentId;
  const parent = plan.items.find((i) => i.row === item.parentRow);
  return parent?.result?.newId || parent?.id || null;
}

const idOf = (item) => item.result?.newId || item.id;

// Estado actual (context=edit, igual para antes y después) de los ítems dados.
async function fetchCurrent(items, plan) {
  const current = new Map();
  const products = items.filter((i) => i.type !== TYPE.variation);
  for (const p of await store.fetchProductsByIds(products.map(idOf))) current.set(`product:${p.id}`, p);
  const byParent = new Map();
  for (const v of items.filter((i) => i.type === TYPE.variation)) {
    const parentId = parentIdOf(v, plan);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(idOf(v));
  }
  for (const [parentId, list] of byParent) {
    for (const v of await store.fetchVariationsByIds(parentId, list)) current.set(`variation:${v.id}`, v);
  }
  return current;
}
const keyOf = (item) => `${item.type === TYPE.variation ? 'variation' : 'product'}:${idOf(item)}`;

/**
 * Consulta en la tienda el estado actual de todo lo que el plan va a modificar.
 * Si no se puede consultar, lanza error: sin respaldo no se sube nada.
 */
async function snapshotBefore(plan, { log = () => {} } = {}) {
  const updates = liveItems(plan).filter((i) => i.kind === 'update');
  if (!updates.length) return new Map();
  log(`Respaldando ${updates.length} producto(s)/variación(es) antes de modificarlos...`);
  const current = await fetchCurrent(updates, plan);
  const snapshot = new Map();
  for (const item of updates) {
    const obj = current.get(keyOf(item));
    if (!obj) throw new Error(`No se pudo respaldar ${item.data.sku || `ID ${item.id}`}: no se encontró en la tienda. No se subió nada.`);
    const fields = fieldsOf(item);
    snapshot.set(item, { kind: keyOf(item).split(':')[0], fields, before: snapshotOf(obj, fields) });
  }
  return snapshot;
}

/** Guarda en la base el respaldo de lo que SÍ se guardó en la tienda. */
async function saveBackup(pool, runId, plan, snapshot) {
  const saved = liveItems(plan).filter((i) => i.result?.ok);
  // "Después" consultado igual que el "antes" (la respuesta del lote trae la descripción ya formateada).
  // Las altas también: crear variaciones cambia la fecha de modificación de su padre.
  const stillThere = saved.filter((i) => i.kind !== 'delete');
  const after = stillThere.length ? await fetchCurrent(stillThere, plan).catch(() => new Map()) : new Map();
  // Lo que se mandó a la papelera: cómo estaba cada versión (idioma), para restaurarla.
  const saveTrashed = (kind, wooId, parentId, sku, versions) => pool.query(
    `INSERT INTO push_backups (run_id, kind, action, woo_id, parent_id, sku, before)
     VALUES ($1,$2,'delete',$3,$4,$5,$6)`,
    [runId, kind, wooId, parentId, sku ?? null, JSON.stringify({ versions })],
  );
  for (const item of saved) {
    const kind = item.type === TYPE.variation ? 'variation' : 'product';
    const parentId = kind === 'variation' ? parentIdOf(item, plan) : null;
    if (item.kind === 'delete') {
      if (item.trashed) await saveTrashed(kind, item.id, parentId, item.data.sku, item.trashed);
    } else if (item.kind === 'create') {
      await pool.query(
        `INSERT INTO push_backups (run_id, kind, action, woo_id, parent_id, sku, after)
         VALUES ($1,$2,'create',$3,$4,$5,$6)`,
        [runId, kind, item.result.newId, parentId, item.data.sku ?? null, JSON.stringify({ date_modified: after.get(keyOf(item))?.date_modified || item.result.data?.date_modified || null })],
      );
      // Simple que pasó a ser esta variación: se respalda después de la variación,
      // así "Deshacer" primero borra la variación (libera el SKU) y luego lo restaura.
      if (item.replaces?.trashed) await saveTrashed('product', item.replaces.id, null, item.replaces.sku, item.replaces.trashed);
    } else if (snapshot.has(item)) {
      const { fields, before } = snapshot.get(item);
      await pool.query(
        `INSERT INTO push_backups (run_id, kind, action, woo_id, parent_id, sku, fields, before, after)
         VALUES ($1,$2,'update',$3,$4,$5,$6,$7,$8)`,
        [runId, kind, item.id, parentId, item.data.sku ?? null, JSON.stringify(fields), JSON.stringify(before), JSON.stringify(snapshotOf(after.get(keyOf(item)) || item.result.data, fields))],
      );
    }
  }
}

module.exports = { snapshotBefore, saveBackup, wooFields, pick, sameValue, toPayload, snapshotOf };
