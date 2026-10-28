// Crea un usuario desde la terminal (necesario para el primer administrador).
// Uso: npm run create-user -- <usuario> "<Nombre visible>" <admin|excel|fotos>
// La contraseña se pide por teclado para que no quede en el historial de la terminal.
require('../src/config');
const { pool, migrate } = require('../src/server/db');
const { createUser } = require('../src/server/auth');
const { askHidden } = require('./prompt');

async function main() {
  const [username, displayName, role] = process.argv.slice(2);
  if (!username || !displayName || !role) {
    console.log('Uso: npm run create-user -- <usuario> "<Nombre visible>" <admin|excel|fotos>');
    process.exitCode = 1;
    return;
  }
  await migrate();
  const password = await askHidden('Contraseña (mínimo 8 caracteres): ');
  const user = await createUser({ username, password, displayName, role });
  console.log(`Usuario creado: ${user.username} (${user.display_name}) — rol ${user.role}`);
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
