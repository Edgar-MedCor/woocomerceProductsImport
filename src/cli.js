#!/usr/bin/env node
const { login } = require('./auth/microsoft');
const onedrive = require('./storage/onedrive');
const pull = require('./commands/pull');
const push = require('./commands/push');

const HELP = `Uso:
  npm run login                     Conecta tu cuenta de Microsoft (una vez por equipo)
  npm run pull                      Trae los productos de WooCommerce al Excel en OneDrive
  npm run pull -- --force           Igual, aunque el Excel tenga cambios posteriores al último pull
  npm run pull -- --local out/x.xlsx  Genera el Excel en una carpeta local (no toca OneDrive)
  npm run pull -- --cache           Usa el último catálogo descargado en vez de consultar la tienda
  npm run push                      Revisa los cambios del Excel de OneDrive (no sube nada)
  npm run push -- --yes             Revisa y sube los cambios a la tienda
  npm run push -- --local x.xlsx    Igual, pero con un Excel local`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

  switch (command) {
    case 'login': {
      await login();
      const me = await onedrive.me();
      console.log(`Conectado como ${me.displayName} (${me.userPrincipalName || me.mail || ''}).`);
      break;
    }
    case 'pull': {
      const { summary } = await pull({
        force: flag('--force'),
        local: option('--local'),
        cache: flag('--cache'),
        onProgress: (done, total) => process.stdout.write(`\r  Variaciones: ${done}/${total} productos${done === total ? '\n' : ''}`),
      });
      console.table(summary);
      break;
    }
    case 'push': {
      const reviewed = await push.review({ local: option('--local') });
      const plan = push.publicPlan(reviewed.plan);
      console.table(plan.summary);
      for (const item of plan.items) {
        const what = [...item.errors.map((e) => `✖ ${e}`), ...item.conflicts.map((c) => `⚠ conflicto en ${c.field}`), ...item.changes.map((c) => `${c.field}: ${c.from ?? ''} → ${c.to}`)];
        console.log(`  fila ${item.row} ${item.sku || ''} ${item.kind === 'create' ? '(nuevo)' : ''}\n    ${what.join('\n    ')}`);
      }
      if (!flag('--yes')) {
        console.log('\nSolo revisión: no se subió nada. Para subir agrega --yes');
        break;
      }
      const result = await push.applyReview(reviewed);
      console.table(result.summary);
      result.warnings.forEach((w) => console.warn(w));
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  const detail = error.response?.data?.message;
  console.error(`\nError: ${error.message}${detail ? ` — ${detail}` : ''}`);
  if (error.code === 'EXCEL_MODIFIED') console.error('Si estás seguro, ejecuta: npm run pull -- --force');
  process.exit(1);
});
