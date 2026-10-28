const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL en .env (ver scripts/setup-db.sql).');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );

    -- Cada pull/push que se ejecuta desde el panel o la terminal.
    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      user_id BIGINT REFERENCES users(id),
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      summary JSONB,
      error TEXT
    );

    -- Detalle campo por campo de lo que cambió un push (valor anterior -> nuevo).
    CREATE TABLE IF NOT EXISTS change_log (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      woo_id BIGINT,
      sku TEXT,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      result TEXT NOT NULL,
      error TEXT
    );

    -- Fotos ya subidas a WordPress (archivo de OneDrive + versión de su contenido),
    -- para no volver a subirlas si un proceso se interrumpe y se repite.
    CREATE TABLE IF NOT EXISTS photo_uploads (
      onedrive_id TEXT NOT NULL,
      content_tag TEXT NOT NULL,
      sku TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_id BIGINT NOT NULL,
      media_url TEXT,
      run_id BIGINT REFERENCES sync_runs(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (onedrive_id, content_tag)
    );

    -- Respaldo de cada push: cómo estaba cada producto/variación justo antes de
    -- tocarlo (before) y cómo quedó (after), para poder deshacerlo.
    CREATE TABLE IF NOT EXISTS push_backups (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,            -- product | variation
      action TEXT NOT NULL,          -- update | create
      woo_id BIGINT NOT NULL,
      parent_id BIGINT,
      sku TEXT,
      fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      before JSONB,
      after JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_push_backups_run ON push_backups(run_id);
    ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;
    ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS undone_by_run BIGINT;
    -- Permisos que el administrador asigna a cada usuario además de su perfil.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_permissions TEXT[] NOT NULL DEFAULT '{}';
    -- Enlace al producto en la tienda, para consultarlo desde el historial.
    ALTER TABLE change_log ADD COLUMN IF NOT EXISTS url TEXT;

    -- Carpetas de fotos cuyo nombre no coincide con ningún SKU y que alguien
    -- relacionó a mano desde el panel. Se guarda el ID de OneDrive (no el
    -- nombre), así la relación sigue aunque la carpeta se renombre o se mueva.
    CREATE TABLE IF NOT EXISTS photo_folder_links (
      folder_id TEXT PRIMARY KEY,
      folder_path TEXT,
      sku TEXT NOT NULL,
      created_by BIGINT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_change_log_run ON change_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_change_log_sku ON change_log(sku);

    -- Si el servidor se reinició a media ejecución, esa ejecución quedó huérfana.
    UPDATE sync_runs SET status = 'error', finished_at = now(), error = 'Interrumpido: el servidor se reinició'
    WHERE status = 'running';
  `);
}

module.exports = { pool, migrate };
