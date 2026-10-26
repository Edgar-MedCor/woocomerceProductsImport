-- Ejecutar UNA sola vez como el usuario "postgres", por ejemplo:
--   "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f scripts/setup-db.sql
-- o pegándolo en pgAdmin > Query Tool.
--
-- ANTES de ejecutarlo cambia CAMBIA_ESTA_CLAVE por una contraseña tuya y usa la
-- misma en DATABASE_URL del .env. No subas este archivo con tu contraseña real.
CREATE ROLE wayan_sync WITH LOGIN PASSWORD 'CAMBIA_ESTA_CLAVE';
CREATE DATABASE wayan_sync OWNER wayan_sync;

-- Las tablas las crea el panel al arrancar (src/server/db.js).
