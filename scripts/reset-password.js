// Restablece la contraseña de un usuario desde la terminal del servidor
// (para cuando no hay otro administrador que lo haga desde el panel).
// Uso: npm run reset-password -- <usuario>
require('../src/config');
const { pool, migrate } = require('../src/server/db');
const { findUserByUsername, setPassword } = require('../src/server/auth');
const { askHidden } = require('./prompt');

async function main() {
  const [username] = process.argv.slice(2);
  if (!username) {
    console.log('Uso: npm run reset-password -- <usuario>');
    const { rows } = await pool.query('SELECT username, display_name, role, active FROM users ORDER BY id');
    console.log('Usuarios:', rows.map((u) => `${u.username} (${u.display_name}, ${u.role}${u.active ? '' : ', desactivado'})`).join(' · ') || 'ninguno');
    process.exitCode = 1;
    return;
  }
  await migrate();
  const user = await findUserByUsername(username);
  if (!user) throw new Error(`No existe el usuario "${username}".`);

  const [password, again] = await askHidden('Nueva contraseña (mínimo 8 caracteres): ', 'Repítela: ');
  if (password !== again) throw new Error('Las contraseñas no coinciden. No se cambió nada.');
  await setPassword(user.id, password);
  if (!user.active) await pool.query('UPDATE users SET active = true WHERE id = $1', [user.id]);

  // Cierra las sesiones abiertas de ese usuario (por si alguien más la conocía).
  const closed = await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(user.id)]).catch(() => ({ rowCount: 0 }));
  console.log(`Contraseña actualizada para ${user.username} (${user.display_name}).${user.active ? '' : ' El usuario estaba desactivado y se reactivó.'} Sesiones cerradas: ${closed.rowCount}.`);
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
