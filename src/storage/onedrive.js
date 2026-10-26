const config = require('../config');
const { getAccessToken } = require('../auth/microsoft');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // Graph: subida directa solo hasta 4 MB
const CHUNK = 5 * 320 * 1024; // los trozos deben ser múltiplos de 320 KiB

// Carpeta raíz: la del vínculo ONEDRIVE_ROOT_URL (p. ej. "4.Sitio Web" en el
// SharePoint del equipo) o, si no hay vínculo, el OneDrive de la cuenta conectada.
let rootPromise = null;
function root() {
  if (!config.storageRootUrl) return Promise.resolve(null);
  rootPromise ??= (async () => {
    const encoded = `u!${Buffer.from(config.storageRootUrl).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
    const res = await graph(`${GRAPH}/shares/${encoded}/driveItem?$select=id,name,folder,webUrl,parentReference`);
    if (res.status === 404) throw new Error('No se encontró la carpeta de ONEDRIVE_ROOT_URL. Revisa el vínculo y que la cuenta conectada tenga acceso.');
    const item = await res.json();
    if (!item.folder) throw new Error('ONEDRIVE_ROOT_URL debe ser el vínculo de una carpeta, no de un archivo.');
    return { driveId: item.parentReference.driveId, id: item.id, name: item.name, webUrl: item.webUrl };
  })().catch((error) => {
    rootPromise = null; // se reintenta en la siguiente llamada
    throw error;
  });
  return rootPromise;
}

async function itemUrl(filePath) {
  const r = await root();
  const rel = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (!r) return rel ? `${GRAPH}/me/drive/root:/${rel}:` : `${GRAPH}/me/drive/root`;
  return rel ? `${GRAPH}/drives/${r.driveId}/items/${r.id}:/${rel}:` : `${GRAPH}/drives/${r.driveId}/items/${r.id}`;
}

async function rootChildrenUrl() {
  const r = await root();
  return r ? `${GRAPH}/drives/${r.driveId}/items/${r.id}/children` : `${GRAPH}/me/drive/root/children`;
}

// Para mostrar en Conexiones: dónde está trabajando el panel.
async function describeRoot() {
  const r = await root();
  return r ? { type: 'sharepoint', name: r.name, webUrl: r.webUrl } : { type: 'onedrive', name: 'OneDrive de la cuenta conectada', webUrl: null };
}

// Si OneDrive pide esperar (429/503) se respeta Retry-After y se reintenta.
async function graph(url, options = {}, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const token = await getAccessToken();
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if ((res.status === 429 || res.status === 503) && attempt < attempts) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      const error = new Error(`OneDrive respondió ${res.status}: ${body.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return res;
  }
}

// ---------- carpetas (fotos) ----------
// Un elemento se identifica por { driveId, id }; así también funcionan las
// carpetas compartidas agregadas como acceso directo ("remoteItem").
const ref = (item) => (item.remoteItem
  ? { driveId: item.remoteItem.parentReference.driveId, id: item.remoteItem.id }
  : { driveId: item.parentReference?.driveId, id: item.id });

async function getItemByPath(folderPath) {
  const res = await graph(`${await itemUrl(folderPath)}?$select=id,name,folder,remoteItem,parentReference`);
  return res.status === 404 ? null : res.json();
}

// Hijos de una carpeta, con todas sus páginas.
async function listChildren({ driveId, id }) {
  const items = [];
  let url = `${GRAPH}/drives/${driveId}/items/${id}/children?$top=200&$select=id,name,size,eTag,cTag,folder,file,remoteItem,parentReference`;
  while (url) {
    const data = await (await graph(url)).json();
    items.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return items;
}

async function downloadItem({ driveId, id }) {
  const res = await graph(`${GRAPH}/drives/${driveId}/items/${id}/content`);
  if (res.status === 404) throw new Error('El archivo ya no existe en OneDrive.');
  return Buffer.from(await res.arrayBuffer());
}

// Crea (si falta) cada carpeta de la ruta y devuelve la última.
async function ensureFolderPath(folderPath) {
  let parent = null;
  let currentPath = '';
  for (const name of folderPath.split('/').filter(Boolean)) {
    currentPath = currentPath ? `${currentPath}/${name}` : name;
    const existing = await getItemByPath(currentPath);
    if (existing) {
      parent = existing;
      continue;
    }
    const parentUrl = parent ? `${GRAPH}/drives/${ref(parent).driveId}/items/${ref(parent).id}/children` : await rootChildrenUrl();
    const res = await graph(parentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    }).catch(async (error) => {
      if (error.status === 409) return { json: async () => getItemByPath(currentPath) }; // la creó otro proceso
      throw error;
    });
    parent = await res.json();
  }
  return parent;
}

// Mueve un elemento a otra carpeta; si ya existe uno con el mismo nombre, OneDrive le agrega un número.
async function moveItem(item, destinationFolder) {
  const { driveId, id } = ref(item);
  const res = await graph(`${GRAPH}/drives/${driveId}/items/${id}?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: ref(destinationFolder).id } }),
  });
  return res.json();
}

async function me() {
  return (await graph(`${GRAPH}/me`)).json();
}

// Metadatos del archivo (eTag, fecha, quién lo modificó) o null si no existe.
async function getFileInfo(filePath) {
  const res = await graph(`${await itemUrl(filePath)}?$select=id,name,eTag,lastModifiedDateTime,lastModifiedBy,webUrl,size`);
  return res.status === 404 ? null : res.json();
}

async function downloadFile(filePath) {
  const res = await graph(`${await itemUrl(filePath)}/content`);
  if (res.status === 404) return null;
  return Buffer.from(await res.arrayBuffer());
}

// `ifMatch`: eTag esperado; si el archivo cambió desde entonces OneDrive responde
// 412 y no se sobrescribe (para no pisar ediciones hechas mientras tanto).
async function uploadFile(filePath, buffer, { ifMatch } = {}) {
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const conditional = ifMatch ? { 'If-Match': ifMatch } : {};
  if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
    const res = await graph(`${await itemUrl(filePath)}/content`, { method: 'PUT', headers: { 'Content-Type': type, ...conditional }, body: buffer });
    return res.json();
  }

  const session = await (await graph(`${await itemUrl(filePath)}/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...conditional },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  })).json();

  let result;
  for (let start = 0; start < buffer.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, buffer.length);
    // La URL de la sesión ya va firmada: no lleva token de Authorization.
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}` },
      body: buffer.subarray(start, end),
    });
    if (!res.ok) throw new Error(`Falló la subida a OneDrive (${res.status}): ${(await res.text()).slice(0, 300)}`);
    result = await res.json();
  }
  return result;
}

module.exports = {
  me, getFileInfo, downloadFile, uploadFile, describeRoot,
  ref, getItemByPath, listChildren, downloadItem, ensureFolderPath, moveItem,
};
