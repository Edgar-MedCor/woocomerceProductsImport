// Recorre la carpeta de fotos pendientes en OneDrive. No necesita conocer las
// categorías: en cada carpeta pregunta "¿este nombre es un SKU (o estilo+color)?".
// Si lo es, sus fotos son de ese producto; si no, es una carpeta para ordenar y se entra en ella.
const onedrive = require('../storage/onedrive');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const UNSUPPORTED_EXT = new Set(['.heic', '.heif', '.tif', '.tiff', '.psd', '.raw', '.cr2', '.nef', '.bmp']);

const ext = (name) => (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
const naturalCompare = (a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

// "RD48415015", "RD48415015 - vestido flores", "rd48415015_fotos" -> candidatos de SKU.
function skuCandidates(folderName) {
  const name = folderName.trim().toUpperCase();
  return [...new Set([name, name.split(/\s+-\s+|\s+/)[0], name.split(/[\s_]+/)[0]])];
}

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

/**
 * @param {string} rootPath   carpeta raíz en OneDrive (ej. "4.Sitio Web/Falta subir")
 * @param {Function} resolve  SKU en mayúsculas -> destino { kind: 'product', ... } o null
 * @param {Function} resolveChild (nombre de subcarpeta, destino del SKU que la contiene) -> destino o null
 *                            (ej. subcarpeta "Negro" dentro de un producto variable)
 * @param {object} options    linkOf: ID de carpeta -> { sku, by } relacionado a mano en el panel, o null
 * @returns { root, folders: [{ sku, target, folder, relativePath, files, parentSkuFolder, linked }], warnings, scannedFolders }
 *          Las carpetas sin SKU llevan `folderId` y `unmatched` en su aviso, para poder relacionarlas.
 */
async function scanPhotos(rootPath, resolve, resolveChild, { onProgress = () => {}, linkOf = () => null } = {}) {
  const root = await onedrive.getItemByPath(rootPath);
  if (!root) {
    const error = new Error(`No existe la carpeta "${rootPath}" en OneDrive.`);
    error.code = 'PHOTOS_ROOT_MISSING';
    throw error;
  }

  const folders = [];
  const warnings = [];
  let scanned = 0;
  let queue = [{ item: root, relativePath: '', skuAncestor: null, ancestorTarget: null }];

  // Recorrido por niveles: cada nivel se consulta en paralelo.
  while (queue.length) {
    const nextLevel = [];
    await withConcurrency(queue, 6, async ({ item, relativePath, skuAncestor, ancestorTarget }) => {
      const children = await onedrive.listChildren(onedrive.ref(item));
      scanned += 1;
      onProgress(scanned);

      const files = children.filter((c) => c.file);
      const subfolders = children.filter((c) => c.folder || c.remoteItem?.folder);
      const images = files.filter((f) => IMAGE_EXT.has(ext(f.name))).sort((a, b) => naturalCompare(a.name, b.name));
      const unsupported = files.filter((f) => UNSUPPORTED_EXT.has(ext(f.name)));

      let sku = null;
      let target = null;
      const where = relativePath || '(carpeta raíz)';
      // Relación hecha a mano en el panel: manda sobre el nombre de la carpeta.
      const linked = relativePath ? linkOf(item.id) : null;
      if (linked) {
        target = resolve(String(linked.sku).trim().toUpperCase());
        if (target) sku = String(linked.sku).trim().toUpperCase();
        if (!target) {
          warnings.push({
            kind: 'link-broken', path: where, folderId: item.id, unmatched: true, linked, fotos: images.length,
            message: `Se relacionó a mano con "${linked.sku}", pero ese SKU ya no está en el Excel. Quita la relación o relaciónala con otro SKU.`,
          });
        }
      }
      for (const candidate of relativePath && !sku ? skuCandidates(item.name) : []) {
        target = resolve(candidate);
        if (target) {
          sku = candidate;
          break;
        }
      }
      if (!sku && ancestorTarget && relativePath) {
        target = resolveChild(item.name.trim(), ancestorTarget);
        if (target) sku = `${ancestorTarget.sku} / ${item.name.trim()}`;
      }

      if (sku) {
        const byLink = Boolean(linked) && sku === String(linked.sku).trim().toUpperCase();
        folders.push({ sku, target, folder: item, relativePath, files: images, parentSkuFolder: skuAncestor, linked: byLink ? linked : null });
        if (!images.length && !subfolders.length) warnings.push({ kind: 'empty', path: where, message: 'Carpeta de SKU sin fotos.' });
      } else if (images.length && !linked) {
        warnings.push({
          kind: relativePath ? 'unmatched' : 'root',
          path: where,
          folderId: relativePath ? item.id : null,
          unmatched: Boolean(relativePath),
          fotos: images.length,
          message: relativePath
            ? `${images.length} foto(s) en una carpeta cuyo nombre no coincide con ningún SKU ni estilo+color de la tienda. ¿Está mal escrito, o el producto aún no se ha dado de alta?`
            : `${images.length} foto(s) sueltas en la carpeta raíz: deben ir dentro de una carpeta con el SKU.`,
        });
      }
      if (unsupported.length) {
        warnings.push({ kind: 'unsupported', path: where, message: `Formato no compatible (convierte a JPG): ${unsupported.map((f) => f.name).join(', ')}` });
      }

      for (const sub of subfolders) {
        nextLevel.push({
          item: sub,
          relativePath: relativePath ? `${relativePath}/${sub.name}` : sub.name,
          skuAncestor: sku ? relativePath : skuAncestor,
          ancestorTarget: target?.kind === 'product' ? target : ancestorTarget,
        });
      }
    });
    queue = nextLevel;
  }

  // El mismo SKU en dos carpetas: no se sabe cuáles fotos usar.
  const bySku = new Map();
  for (const f of folders) bySku.set(f.sku, [...(bySku.get(f.sku) || []), f]);
  const duplicated = new Set();
  for (const [sku, list] of bySku) {
    if (list.length > 1) {
      duplicated.add(sku);
      // Si una de ellas se relacionó a mano, desde el aviso se puede quitar esa relación.
      const linkedOne = list.find((f) => f.linked);
      warnings.push({
        kind: 'duplicate',
        path: list.map((f) => f.relativePath).join(' y '),
        folderId: linkedOne?.folder.id || null,
        linked: linkedOne?.linked || null,
        linkedPath: linkedOne?.relativePath || null,
        message: `El SKU ${sku} tiene ${list.length} carpetas. Junta las fotos en una sola; mientras tanto no se sube.`,
      });
    }
  }

  return {
    root,
    folders: folders.filter((f) => !duplicated.has(f.sku)).sort((a, b) => naturalCompare(a.relativePath, b.relativePath)),
    warnings,
    scannedFolders: scanned,
  };
}

module.exports = { scanPhotos, skuCandidates };
