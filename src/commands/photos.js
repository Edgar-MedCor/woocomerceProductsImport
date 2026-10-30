// Fotos: OneDrive -> WordPress. Reglas (solo nombres exactos, nada se adivina):
//   <categorías...>/<SKU de producto>/          -> galería del producto (la 1ª es la principal)
//   <categorías...>/<estilo+color>/             -> foto de todas las tallas de ese color (RD49432005)
//   <SKU de producto variable>/<Color>/         -> foto de todas las variaciones de ese color
//   <SKU de producto variable>/<SKU variación>/ -> foto de esa variación
// Paso 1 (reviewPhotos) solo revisa; paso 2 (applyPhotos) sube, asigna y mueve
// las carpetas terminadas a la carpeta de subidas con la misma ruta.
const path = require('path').posix;
const config = require('../config');
const onedrive = require('../storage/onedrive');
const store = require('../woo/store');
const { uploadMedia, mediaExists } = require('../woo/media');
const { readWorkbook } = require('../excel/reader');
const { scanPhotos } = require('../photos/scan');
const { prepareImage } = require('../photos/image');
const { TYPE, isBlank } = require('../push/fields');

const key = (s) => String(s || '').trim().toUpperCase();
// estilo (letras+números) + talla (letras) + color (2 o 3 dígitos; en la tienda casi siempre 3)
const SKU_PARTS = /^([A-Z]+\d+)([A-Z]+)(\d{2,3})$/;
// Lo que se acepta al relacionar una carpeta a mano (mismo criterio que en el panel).
const SKU_FORMAT = /^[A-Z0-9][A-Z0-9._-]{1,59}$/;
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');

async function withConcurrency(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// Destinos posibles a partir del Excel (que ya trae los IDs de la tienda).
function buildTargets(rows) {
  const bySku = new Map();
  for (const r of rows) {
    if (isBlank(r.sku)) continue;
    bySku.set(key(r.sku), {
      kind: 'product',
      sku: String(r.sku).trim(),
      id: isBlank(r.id) ? null : Number(r.id),
      type: r.type || null,
      name: r.name || null,
      parentSku: isBlank(r.parentSku) ? null : key(r.parentSku),
      colors: new Map(), // solo en variables: color -> variaciones
    });
  }
  for (const r of rows.filter((x) => x.type === TYPE.variation)) {
    const parent = bySku.get(key(r.parentSku));
    if (!parent) continue;
    const color = String(r.attr_color || '').trim().toLowerCase();
    if (color) parent.colors.set(color, [...(parent.colors.get(color) || []), { id: isBlank(r.id) ? null : Number(r.id), sku: r.sku || null }]);
  }
  for (const t of bySku.values()) {
    if (t.type === TYPE.variation) {
      const parent = bySku.get(t.parentSku);
      t.parentId = parent?.id || null;
      t.name = parent?.name || t.name;
    }
  }

  // Convención de Wayan: SKU = estilo + talla + color (RD49432 + OS + 005). Las
  // carpetas de fotos usan estilo + color (RD49432005): una foto para todas las tallas.
  const byStyleColor = new Map();
  for (const r of rows) {
    const m = key(r.sku).match(SKU_PARTS);
    if (!m || (r.type !== TYPE.variation && r.type !== TYPE.simple)) continue;
    const code = m[1] + m[3];
    byStyleColor.set(code, [...(byStyleColor.get(code) || []), r]);
  }

  const resolve = (code) => {
    if (bySku.has(code)) return bySku.get(code);
    const matches = byStyleColor.get(code);
    if (!matches) return null;
    if (matches.length === 1 && matches[0].type === TYPE.simple) return bySku.get(key(matches[0].sku));
    const variations = matches.filter((r) => r.type === TYPE.variation);
    const parents = [...new Set(variations.map((r) => key(r.parentSku)))];
    // Si un código cae en dos productos, no se adivina: se reporta como carpeta desconocida.
    if (parents.length !== 1 || variations.length !== matches.length) return null;
    const parent = bySku.get(parents[0]);
    return {
      kind: 'color',
      sku: parent?.sku || parents[0],
      color: code,
      parentId: parent?.id || null,
      name: parent?.name || null,
      variations: variations.map((r) => ({ id: isBlank(r.id) ? null : Number(r.id), sku: r.sku })),
    };
  };
  const resolveChild = (folderName, ancestor) => {
    if (ancestor.type !== TYPE.variable) return null;
    const variations = ancestor.colors.get(folderName.toLowerCase());
    if (!variations) return null;
    return { kind: 'color', sku: ancestor.sku, color: folderName, parentId: ancestor.id, name: ancestor.name, variations };
  };
  return { resolve, resolveChild };
}

async function loadTargets() {
  const excelBuffer = await onedrive.downloadFile(config.excelPath());
  if (!excelBuffer) throw new Error('No existe el Excel en OneDrive. Haz primero "Traer de la tienda".');
  const { rows } = await readWorkbook(excelBuffer);
  return buildTargets(rows);
}

const describe = (t) => ({
  label: t.kind === 'color' ? `${t.sku} / ${t.color}` : t.sku,
  name: t.name || null,
  type: t.kind === 'color' ? `Color (fotos para sus ${t.variations.length} variación(es))` : t.type,
});

/**
 * A qué producto iría una carpeta relacionada con este SKU (mismas reglas que
 * el nombre de carpeta: SKU exacto o estilo+color). Error si no se reconoce.
 */
async function checkSku(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) throw new Error('Escribe el SKU.');
  if (!SKU_FORMAT.test(code)) throw new Error('El SKU solo puede tener letras, números, guion, punto o guion bajo (sin espacios).');
  const target = (await loadTargets()).resolve(code);
  if (!target) throw new Error(`"${code}" no coincide con ningún SKU ni estilo+color del Excel. Revisa que esté bien escrito o que el producto ya esté dado de alta.`);
  return { sku: code, ...describe(target) };
}

/**
 * Paso 1: recorre las carpetas y arma la lista de qué fotos van a qué producto.
 * `links`: relaciones carpeta -> SKU hechas a mano en el panel (ver photos/links.js).
 */
async function reviewPhotos({ log = console.log, progress = () => {}, links = new Map() } = {}) {
  log('Leyendo los SKUs del Excel...');
  const { resolve, resolveChild } = await loadTargets();

  log(`Recorriendo "${config.photos.pendingPath}" en OneDrive...`);
  const scan = await scanPhotos(config.photos.pendingPath, resolve, resolveChild, {
    onProgress: (n) => progress(n, null, 'Carpetas revisadas'),
    linkOf: (folderId) => links.get(folderId) || null,
  });

  const items = [];
  for (const folder of scan.folders) {
    if (!folder.files.length) continue;
    const t = folder.target;
    const item = {
      path: folder.relativePath,
      target: t,
      label: t.kind === 'color' ? `${t.sku} / ${t.color}` : t.sku,
      name: t.name,
      type: t.kind === 'color' ? 'Color' : t.type,
      folder: folder.folder,
      parentSkuFolder: folder.parentSkuFolder,
      linked: folder.linked,
      files: folder.files,
      errors: [],
      warnings: [],
    };
    if (folder.linked) item.warnings.push(`Carpeta relacionada a mano con ${folder.linked.sku}${folder.linked.by ? ` por ${folder.linked.by}` : ''}.`);
    if (t.kind === 'color') {
      if (!t.parentId || t.variations.some((v) => !v.id)) item.errors.push('El producto o alguna de sus variaciones todavía no existe en la tienda. Sube primero los datos.');
    } else {
      if (!t.id) item.errors.push('El producto todavía no existe en la tienda. Sube primero los datos ("Revisar cambios" → "Subir").');
      if (t.type === TYPE.variation && !t.parentId) item.errors.push('No se encontró el producto padre de esta variación en el Excel.');
    }
    items.push(item);
  }

  // Volumen: se sube en tandas para no dejar el proceso horas corriendo.
  const ready = items.filter((i) => !i.errors.length);
  ready.slice(config.photos.maxSkusPerRun).forEach((i) => {
    i.deferred = true;
    i.warnings.push('Se subirá en la siguiente tanda (límite por ejecución).');
  });
  const toUpload = ready.filter((i) => !i.deferred);

  // Padres variables sin foto cuyas variaciones ya tienen (p. ej. si su galería
  // falló en una subida anterior): se les arma también, sin subir nada nuevo.
  log('Buscando productos padre sin foto...');
  const uploading = new Set(toUpload.filter((i) => i.target.kind === 'color' || i.type === TYPE.variation).map((i) => i.target.parentId));
  const parentGalleries = (await findParentsWithoutPhoto()).filter((p) => !uploading.has(p.id));

  return {
    items,
    parentGalleries,
    folders: scan.folders.map((f) => ({ relativePath: f.relativePath, folder: f.folder, parentSkuFolder: f.parentSkuFolder })),
    warnings: scan.warnings,
    summary: {
      'Carpetas revisadas': scan.scannedFolders,
      'Productos/colores con fotos nuevas': toUpload.length,
      'Productos padre sin foto (se arma su galería)': parentGalleries.length,
      'Fotos a subir': toUpload.reduce((n, i) => n + i.files.length, 0),
      'Con error (no se suben)': items.filter((i) => i.errors.length).length,
      'Para la siguiente tanda': items.filter((i) => i.deferred).length,
      Avisos: scan.warnings.length,
    },
    reviewedAt: new Date(),
  };
}

// Productos variables sin foto principal con al menos una variación con foto.
async function findParentsWithoutPhoto() {
  const products = await store.fetchProductsLite();
  const out = [];
  // Solo los que tienen variaciones: los Variable vacíos (variantes sueltas viejas) no tienen de dónde sacar foto.
  for (const p of products.filter((x) => x.type === 'variable' && !x.images?.length && x.variations?.length)) {
    const variations = await store.fetchAllVariations(p.id);
    if (variations.some((v) => v.image?.id)) out.push({ id: p.id, sku: p.sku, name: p.name });
  }
  return out;
}

// Galería del padre: la foto principal de cada variación, en el orden de las
// variaciones. La primera queda como foto principal del padre y las demás en su galería.
async function buildParentGallery(parentId) {
  const variations = (await store.fetchAllVariations(parentId))
    .sort((a, b) => (a.menu_order ?? 0) - (b.menu_order ?? 0) || a.id - b.id);
  const imageIds = [...new Set(variations.map((v) => v.image?.id).filter(Boolean))];
  if (!imageIds.length) return 0;
  // Guardar las mismas fotos es idempotente: se reintenta si la tienda pide esperar (429).
  await store.request('put', `products/${parentId}`, { images: imageIds.map((id) => ({ id })) });
  return imageIds.length;
}

async function uploadFiles(item, { pool, runId }) {
  const mediaIds = [];
  const t = item.target;
  const isCode = t.kind === 'color' && key(t.color).startsWith(key(t.sku));
  const base = t.kind === 'color' ? (isCode ? key(t.color) : `${t.sku}-${slug(t.color)}`) : t.sku;
  for (const [n, file] of item.files.entries()) {
    const tag = file.cTag || file.eTag;
    const known = pool && (await pool.query('SELECT media_id FROM photo_uploads WHERE onedrive_id = $1 AND content_tag = $2', [file.id, tag])).rows[0];
    if (known) {
      mediaIds.push(Number(known.media_id));
      continue;
    }
    const original = await onedrive.downloadItem(onedrive.ref(file));
    const prepared = await prepareImage(original, file.name, slug(`${base}-${n + 1}`));
    const media = await uploadMedia({ ...prepared, title: item.name });
    if (pool) {
      await pool.query(
        `INSERT INTO photo_uploads (onedrive_id, content_tag, sku, file_name, media_id, media_url, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [file.id, tag, item.label, file.name, media.id, media.url, runId || null],
      );
    }
    mediaIds.push(media.id);
  }
  return mediaIds;
}

// Variación: la 1ª foto es su imagen y las demás su galería (campo que agrega
// wordpress/wayan-sync-variation-gallery.php a la API).
const variationPhotos = (mediaIds) => ({ image: { id: mediaIds[0] }, gallery_image_ids: mediaIds.slice(1) });

async function assign(item, mediaIds) {
  const t = item.target;
  if (t.kind === 'color') {
    const res = await store.request('post', `products/${t.parentId}/variations/batch`, {
      update: t.variations.map((v) => ({ id: v.id, ...variationPhotos(mediaIds) })),
    }, undefined, 1);
    const failed = (res.data.update || []).filter((r) => r.error);
    if (failed.length) throw new Error(failed.map((r) => r.error.message).join('; '));
    return `${mediaIds.length} foto(s) asignada(s) a ${t.variations.length} variación(es) del color ${t.color}`;
  }
  if (t.type === TYPE.variation) {
    await store.request('put', `products/${t.parentId}/variations/${t.id}`, variationPhotos(mediaIds), undefined, 2);
    return `${mediaIds.length} foto(s) asignada(s) a la variación`;
  }
  let images = mediaIds.map((id) => ({ id }));
  if (config.photos.mode === 'append') {
    const current = (await store.request('get', `products/${t.id}`, { context: 'edit' })).data.images || [];
    images = [...current.map((img) => ({ id: img.id })), ...images.filter((img) => !current.some((c) => c.id === img.id))];
  }
  await store.request('put', `products/${t.id}`, { images }, undefined, 2);
  return `Galería con ${mediaIds.length} foto(s)`;
}

// Ruta de destino: misma ruta de categorías, aplicando el cambio de prefijo (F.S. -> S.).
function donePath(relativeDir) {
  const parts = relativeDir === '.' ? [] : relativeDir.split('/').map((part) => {
    for (const [from, to] of config.photos.doneRename) if (part.startsWith(from)) return to + part.slice(from.length);
    return part;
  });
  return [config.photos.donePath, ...parts].join('/');
}

/** Paso 2: sube las fotos, las asigna y mueve las carpetas terminadas. */
async function applyPhotos(review, { pool, runId, log = console.log, progress = () => {} } = {}) {
  const items = review.items.filter((i) => !i.errors.length && !i.deferred);
  let done = 0;

  // Las galerías de variación necesitan el complemento en la tienda; sin él la
  // API ignoraría las fotos extra en silencio, así que se comprueba antes.
  const sample = items.find((i) => i.target.kind === 'color' || i.type === TYPE.variation);
  if (sample) {
    const t = sample.target;
    const variationId = t.kind === 'color' ? t.variations[0].id : t.id;
    const { data } = await store.request('get', `products/${t.parentId}/variations/${variationId}`, {});
    if (!('gallery_image_ids' in data)) {
      throw new Error('La tienda no tiene instalado el complemento de galería por variación (wordpress/wayan-sync-variation-gallery.php). Sin él solo se guardaría una foto por variación, así que no se subió nada.');
    }
  }

  await withConcurrency(items, config.photos.concurrency, async (item) => {
    try {
      let mediaIds = await uploadFiles(item, { pool, runId });
      let message;
      try {
        message = await assign(item, mediaIds);
      } catch (error) {
        // Una foto ya subida antes pudo borrarse de la Biblioteca de medios: se
        // olvidan las que ya no existen, se vuelven a subir y se asigna otra vez.
        const text = error.response?.data?.message || error.message || '';
        if (!pool || !/#\d+/.test(text) || !/imagen|image/i.test(text)) throw error;
        const missing = [];
        for (const id of new Set(mediaIds)) if (!(await mediaExists(id))) missing.push(id);
        if (!missing.length) throw error;
        await pool.query('DELETE FROM photo_uploads WHERE media_id = ANY($1::bigint[])', [missing]);
        log(`↻ ${item.label}: ${missing.length} foto(s) ya no existían en WordPress (se borraron de la biblioteca); se vuelven a subir.`);
        mediaIds = await uploadFiles(item, { pool, runId });
        message = await assign(item, mediaIds);
      }
      item.result = { ok: true, message, mediaIds };
    } catch (error) {
      item.result = { ok: false, message: error.response?.data?.message || error.message };
    }
    done += 1;
    progress(done, items.length, 'Productos con fotos');
    log(`${item.result.ok ? '✔' : '✖'} ${item.label}: ${item.result.message}`);
  });

  // Galería del padre: una foto por variación (su foto principal), en el orden
  // de las variaciones. Solo para los productos variables cuyas variaciones
  // recibieron fotos ahora; los colores no subidos conservan su foto actual.
  // También los padres sin foto que encontró la revisión.
  const parentIds = [...new Set([
    ...items.filter((i) => i.result?.ok && (i.target.kind === 'color' || i.type === TYPE.variation)).map((i) => i.target.parentId),
    ...(review.parentGalleries || []).map((p) => p.id),
  ])];
  const skuOf = new Map([
    ...items.map((i) => [i.target.parentId, i.target.sku]),
    ...(review.parentGalleries || []).map((p) => [p.id, p.sku]),
  ]);
  let parentsUpdated = 0;
  const failedParents = new Set();
  for (const parentId of parentIds) {
    const label = skuOf.get(parentId) || `ID ${parentId}`;
    try {
      const count = await buildParentGallery(parentId);
      if (!count) continue;
      parentsUpdated += 1;
      log(`✔ Galería del producto ${label}: ${count} foto(s), una por variación`);
    } catch (error) {
      failedParents.add(parentId);
      log(`✖ No se pudo armar la galería del producto ${label}: ${error.response?.data?.message || error.message}. Se reintenta en la próxima subida.`);
    }
    await new Promise((r) => setTimeout(r, 500)); // respiro para el hosting
  }
  review.parentResults = new Map((review.parentGalleries || []).map((p) => [p.id, !failedParents.has(p.id)]));

  // Se mueve la carpeta de SKU de primer nivel solo si todo lo que contiene
  // (galería, colores, variaciones) se subió completo y la galería de su padre se armó.
  log(`Moviendo carpetas terminadas a "${config.photos.donePath}"...`);
  const moved = [];
  const notMoved = [];
  for (const top of review.folders.filter((f) => !f.parentSkuFolder)) {
    const group = review.items.filter((i) => i.path === top.relativePath || i.path.startsWith(`${top.relativePath}/`));
    if (!group.length) continue;
    if (!group.every((i) => i.result?.ok && !failedParents.has(i.target.parentId))) {
      if (group.some((i) => i.result)) notMoved.push(top.relativePath);
      continue;
    }
    try {
      const destination = await onedrive.ensureFolderPath(donePath(path.dirname(top.relativePath)));
      await onedrive.moveItem(top.folder, destination);
      moved.push(top.relativePath);
    } catch (error) {
      notMoved.push(`${top.relativePath} (${error.message})`);
    }
  }

  const ok = items.filter((i) => i.result?.ok);
  return {
    summary: {
      'Productos/colores con fotos asignadas': ok.length,
      'Con error': items.length - ok.length,
      'Fotos subidas': ok.reduce((n, i) => n + i.result.mediaIds.length, 0),
      'Galerías de producto padre actualizadas': parentsUpdated,
      'Galerías de producto padre con error': failedParents.size,
      'Carpetas movidas a subidas': moved.length,
    },
    notMoved,
  };
}

// Versión para el panel (mismo formato que la revisión de datos).
function publicPhotos(review, { withResults = false } = {}) {
  return {
    summary: review.summary,
    notes: review.warnings.map((w) => `${w.path}: ${w.message}`),
    items: review.items.map((i) => ({
      row: i.path,
      kind: 'update',
      type: i.type,
      id: i.target.id || i.target.parentId || null,
      sku: i.label,
      name: i.name,
      attributes: i.target.kind === 'color' ? `${i.target.variations.length} variación(es)` : null,
      changes: [{ field: i.target.kind === 'color' || i.type === TYPE.variation ? 'Fotos de la variación' : 'Galería', from: null, to: i.files.map((f) => f.name).join(', ') }],
      conflicts: [],
      skipped: [],
      errors: i.errors,
      warnings: i.warnings,
    })).concat((review.parentGalleries || []).map((p) => ({
      row: p.sku || `ID ${p.id}`,
      kind: 'update',
      type: 'Variable',
      id: p.id,
      sku: p.sku,
      name: p.name,
      attributes: null,
      changes: [{ field: 'Galería del padre', from: null, to: 'Foto principal y galería con la primera foto de cada variación' }],
      conflicts: [],
      skipped: [],
      errors: [],
      warnings: ['No tiene foto, pero sus variaciones sí. No se sube nada nuevo.'],
    }))),
    results: withResults
      ? review.items.filter((i) => i.result).map((i) => ({ row: i.path, sku: i.label, ok: i.result.ok, message: i.result.message }))
        .concat((review.parentGalleries || []).filter((p) => review.parentResults?.has(p.id)).map((p) => ({
          row: p.sku || `ID ${p.id}`, sku: p.sku, ok: review.parentResults.get(p.id),
          message: review.parentResults.get(p.id) ? 'Galería del padre armada' : 'No se pudo armar la galería (ver Detalle); se reintenta en la próxima subida',
        })))
      : undefined,
  };
}

module.exports = { reviewPhotos, applyPhotos, publicPhotos, donePath, buildTargets, checkSku };
