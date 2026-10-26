# Instalar Wayan Sync en el VPS de la agencia

Servidor: AlmaLinux 8.10 · IP 50.6.192.242 · nginx · pm2 · PostgreSQL 15 · Node 24.
Dominio: `wooasync.neo-emarketing.com` (registro A → **50.6.192.242**).
Proyecto: `/var/www/woocomerceProductsImport` · Puerto del panel: **3100** (el 3000 lo usa otra app).

El VPS es compartido con otras aplicaciones (pm2 y nginx): **no reiniciar pm2 completo ni editar
archivos de otros sitios**. Todos los comandos son para `wayan-sync` o su propio archivo de nginx.

## 1. Puerto libre
```bash
ss -ltn | grep ':3100 ' || echo "3100 libre"
```
Si estuviera ocupado, usar otro (p. ej. 3101) en `.env` y en el archivo de nginx.

## 2. Base de datos (propia del panel, en el PostgreSQL compartido)
```bash
sudo -u postgres psql -c "CREATE ROLE wayansync LOGIN PASSWORD 'CAMBIA_ESTA_CLAVE';"
sudo -u postgres psql -c "CREATE DATABASE wayan_sync OWNER wayansync;"
psql "postgresql://wayansync:CAMBIA_ESTA_CLAVE@127.0.0.1:5432/wayan_sync" -c "select 1"
```
Si el último comando falla con *"Ident authentication failed"*: en `pg_hba.conf`
(`sudo -u postgres psql -c "show hba_file"`) la línea `host ... 127.0.0.1/32` debe usar
`scram-sha-256` o `md5`, no `ident`. Cambiarla afecta a todas las apps: revisar antes cómo se
conectan las demás (lo normal es que ya esté en `md5`/`scram-sha-256`).

## 3. Dependencias
```bash
cd /var/www/woocomerceProductsImport && npm ci --omit=dev
```

## 4. Configuración (`.env` en la carpeta del proyecto)
Copiar `.env.example` → `.env` y llenarlo con los valores de producción (WooCommerce, WordPress,
Microsoft, SharePoint, rutas). Además:
```
NODE_ENV=production
PORT=3100
DATABASE_URL=postgresql://wayansync:CAMBIA_ESTA_CLAVE@127.0.0.1:5432/wayan_sync
SESSION_SECRET=<salida de: openssl rand -hex 32>
```
```bash
chmod 600 .env
```

## 5. Arrancar con pm2
```bash
pm2 start deploy/ecosystem.config.js && pm2 save
curl http://127.0.0.1:3100/api/health        # debe responder {"ok":true}
```
Si no responde: `pm2 logs wayan-sync --lines 50`.

## 6. nginx + HTTPS
```bash
cp deploy/nginx-wooasync.conf /etc/nginx/conf.d/wooasync.neo-emarketing.com.conf
nginx -t && systemctl reload nginx
certbot --nginx -d wooasync.neo-emarketing.com
curl https://wooasync.neo-emarketing.com/api/health
```
`certbot` necesita que el DNS ya apunte a 50.6.192.242 (`dig +short wooasync.neo-emarketing.com`).
`nginx -t` revisa **todos** los sitios: si marca error, no recargar y revisar el mensaje.

## 7. Primer uso
1. Administrador: `npm run create-user -- <usuario> "<Nombre>" admin` (pide la contraseña).
2. `https://wooasync.neo-emarketing.com` → **Conexiones → Conectar OneDrive** (cuenta de Wayan).
3. **Catálogo → Traer de la tienda** (unos 2 minutos con bywayan.com).

## 8. Respaldo diario de la base
```bash
chmod +x deploy/backup-db.sh
crontab -e        # agregar: 0 3 * * * /var/www/woocomerceProductsImport/deploy/backup-db.sh
```
Los respaldos quedan en `/var/backups/wayan-sync` (14 días).

## Operación
| Tarea | Comando |
|---|---|
| Estado | `pm2 status wayan-sync` |
| Registros | `pm2 logs wayan-sync` |
| Reiniciar | `pm2 restart wayan-sync` |
| Actualizar versión | `cd /var/www/woocomerceProductsImport && git pull && npm ci --omit=dev && pm2 restart wayan-sync` |

Antes de reiniciar o actualizar, revisar en el panel que no haya una sincronización en curso.
La sesión de Microsoft queda en `/root/.wayan-sync/` (el panel corre como root, igual que las demás apps de pm2).
