const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(event, payload = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...payload }) + '\n';
  fs.appendFileSync(path.join(logsDir, 'app.log'), line);
}

module.exports = { log };
