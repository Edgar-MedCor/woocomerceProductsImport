// Relaciones manuales carpeta -> SKU: solo para carpetas cuyo nombre no se
// reconoce. Las demás se siguen reconociendo por su nombre como siempre.

/** Map(ID de carpeta en OneDrive -> { sku, by, at }) */
async function loadLinks(pool) {
  const { rows } = await pool.query(
    `SELECT l.folder_id, l.sku, l.created_at, u.display_name
     FROM photo_folder_links l LEFT JOIN users u ON u.id = l.created_by`,
  );
  return new Map(rows.map((r) => [r.folder_id, { sku: r.sku, by: r.display_name || null, at: r.created_at }]));
}

async function saveLink(pool, { folderId, folderPath, sku, userId }) {
  await pool.query(
    `INSERT INTO photo_folder_links (folder_id, folder_path, sku, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (folder_id) DO UPDATE SET folder_path = $2, sku = $3, created_by = $4, created_at = now()`,
    [folderId, folderPath || null, sku, userId],
  );
}

/** Devuelve la relación que se quitó (o null si no había). */
async function removeLink(pool, folderId) {
  const { rows } = await pool.query('DELETE FROM photo_folder_links WHERE folder_id = $1 RETURNING folder_path, sku', [folderId]);
  return rows[0] || null;
}

module.exports = { loadLinks, saveLink, removeLink };
