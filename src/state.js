const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./config');

// Recuerda, por cada Excel, la versión (eTag) que dejó el último pull, para
// saber si alguien lo editó después y no pisar cambios sin subir.
const FILE = path.join(STATE_DIR, 'state.json');

function readAll() {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
}

function get(excelPath) {
  return readAll()[excelPath] || null;
}

function set(excelPath, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...readAll(), [excelPath]: value }, null, 2));
}

module.exports = { get, set };
