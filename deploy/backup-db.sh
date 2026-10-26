#!/bin/sh
# Respaldo diario de la base del panel (usuarios, historial, respaldos de push).
# Cron de root:  0 3 * * * /var/www/woocomerceProductsImport/deploy/backup-db.sh
set -e
APP=/var/www/woocomerceProductsImport
DIR=/var/backups/wayan-sync
mkdir -p "$DIR"
DATABASE_URL=$(grep '^DATABASE_URL=' "$APP/.env" | cut -d= -f2-)
pg_dump --no-owner "$DATABASE_URL" | gzip > "$DIR/wayan_sync-$(date +%F).sql.gz"
# Conserva los últimos 14 días.
find "$DIR" -name 'wayan_sync-*.sql.gz' -mtime +14 -delete
