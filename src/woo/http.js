// Conexión a la tienda. Con WOO_ORIGIN_IP las peticiones van directo al
// servidor de la tienda en vez de pasar por el CDN de Hostinger, que es quien
// corta con 429. Se sigue usando el dominio (mismo certificado y mismo sitio):
// solo cambia a qué IP se conecta. Sin la variable, todo funciona como siempre.
const https = require('https');
const dns = require('dns');
const config = require('../config');

const wooHost = () => new URL(config.woo.url()).hostname;

function lookup(hostname, options, callback) {
  const ip = config.woo.originIp;
  if (!ip || hostname !== wooHost()) return dns.lookup(hostname, options, callback);
  const family = ip.includes(':') ? 6 : 4;
  // Node pide a veces todas las direcciones (all: true) y a veces solo una.
  if (options?.all) return callback(null, [{ address: ip, family }]);
  return callback(null, ip, family);
}

const httpsAgent = new https.Agent({ keepAlive: true, lookup });

module.exports = { httpsAgent, usingOrigin: () => Boolean(config.woo.originIp) };
