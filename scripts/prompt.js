const readline = require('readline');

// Hace una o varias preguntas por teclado sin mostrar lo que se escribe
// (contraseñas). Las líneas se guardan en orden, así también funciona si las
// respuestas llegan juntas por tubería (printf ... | npm run ...).
function askHidden(...questions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl._writeToOutput = () => {}; // no repetir en pantalla lo que se teclea
  const pending = [];
  let waiting = null;
  rl.on('line', (line) => {
    if (waiting) { const w = waiting; waiting = null; w(line); } else pending.push(line);
  });
  rl.on('close', () => { if (waiting) { const w = waiting; waiting = null; w(''); } });

  const ask = (q) => new Promise((resolve) => {
    process.stdout.write(q);
    const done = (line) => { process.stdout.write('\n'); resolve(line); };
    if (pending.length) done(pending.shift());
    else waiting = done;
  });

  return (async () => {
    const answers = [];
    for (const q of questions) answers.push(await ask(q));
    rl.close();
    return questions.length === 1 ? answers[0] : answers;
  })();
}

module.exports = { askHidden };
