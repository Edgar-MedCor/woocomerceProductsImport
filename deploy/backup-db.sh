#!/bin/sh
# Respaldo diario de la base del panel (usuarios, historial, respaldos de push).
# Cron del usuario wayansync:  0 3 * * * /opt/wayan-sync/deploy/backup-db.sh
set -e
DIR=/home/wayansync/backups
mkdir -p "$DIR"
pg_dump --no-owner wayan_sync | gzip > "$DIR/wayan_sync-$(date +%F).sql.gz"
# Conserva los últimos 14 días.
find "$DIR" -name 'wayan_sync-*.sql.gz' -mtime +14 -delete
