// pm2: cd /var/www/woocomerceProductsImport && pm2 start deploy/ecosystem.config.js && pm2 save
// El puerto, la base y las llaves salen del .env (NODE_ENV=production y PORT=3100 incluidos).
module.exports = {
  apps: [{
    name: 'wayan-sync',
    cwd: '/var/www/woocomerceProductsImport',
    script: 'src/server/index.js',
    max_memory_restart: '600M',
    // Da tiempo a terminar de escribir antes de matar el proceso al reiniciar.
    kill_timeout: 30000,
  }],
};
