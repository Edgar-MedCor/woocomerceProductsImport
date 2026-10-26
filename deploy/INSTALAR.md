# Instalar Wayan Sync en un VPS (Ubuntu 22.04 / 24.04)

Requisitos: acceso `sudo`, un subdominio apuntando al VPS (registro A, p. ej. `sync.bywayan.com`)
y el `.env` de producción. Todo se instala en `/opt/wayan-sync` y corre como el usuario `wayansync`.

## 1. Paquetes
```bash
sudo apt update && sudo apt install -y git nginx postgresql certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo adduser --system --group --home /home/wayansync wayansync
```

## 2. Base de datos
```bash
sudo -u postgres psql -c "CREATE ROLE wayansync LOGIN PASSWORD 'CAMBIA_ESTA_CLAVE';"
sudo -u postgres psql -c "CREATE DATABASE wayan_sync OWNER wayansync;"
```
Usar el mismo nombre de rol que el usuario del sistema permite que el respaldo (`backup-db.sh`) entre sin contraseña.

## 3. Código
```bash
sudo git clone <URL del repositorio> /opt/wayan-sync
sudo chown -R wayansync:wayansync /opt/wayan-sync
cd /opt/wayan-sync && sudo -u wayansync npm ci --omit=dev
```

## 4. Configuración (`/opt/wayan-sync/.env`)
Copiar `.env.example` y llenarlo con los valores de producción. Diferencias con la PC local:
```
NODE_ENV=production
DATABASE_URL=postgresql://wayansync:CAMBIA_ESTA_CLAVE@localhost:5432/wayan_sync
SESSION_SECRET=<cadena aleatoria larga: openssl rand -hex 32>
```
Proteger el archivo: `sudo chmod 600 /opt/wayan-sync/.env && sudo chown wayansync: /opt/wayan-sync/.env`

## 5. Servicio
```bash
sudo cp deploy/wayan-sync.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wayan-sync
curl http://127.0.0.1:3000/api/health      # debe responder {"ok":true}
```

## 6. HTTPS
```bash
sudo cp deploy/nginx-wayan-sync.conf /etc/nginx/sites-available/wayan-sync
sudo sed -i 's/sync.ejemplo.com/sync.bywayan.com/' /etc/nginx/sites-available/wayan-sync
sudo ln -s /etc/nginx/sites-available/wayan-sync /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sync.bywayan.com
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

## 7. Primer uso
1. Crear el administrador: `cd /opt/wayan-sync && sudo -u wayansync npm run create-user -- <usuario> "<Nombre>" admin`
2. Entrar a `https://sync.bywayan.com` → **Conexiones → Conectar OneDrive** (iniciar sesión con la cuenta de Wayan).
3. **Catálogo → Traer de la tienda** para crear el Excel.

## 8. Respaldo diario de la base
```bash
sudo chmod +x /opt/wayan-sync/deploy/backup-db.sh
sudo crontab -u wayansync -e     # agregar: 0 3 * * * /opt/wayan-sync/deploy/backup-db.sh
```

## Operación
| Tarea | Comando |
|---|---|
| Ver si está corriendo | `sudo systemctl status wayan-sync` |
| Ver registros | `sudo journalctl -u wayan-sync -f` |
| Actualizar a una versión nueva | `cd /opt/wayan-sync && sudo -u wayansync git pull && sudo -u wayansync npm ci --omit=dev && sudo systemctl restart wayan-sync` |

Antes de reiniciar, revisar en el panel que no haya una sincronización en curso.
