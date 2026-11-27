// Проигрывает запись хуков в слушатель — в окно ΒybAi или в dev/bridge.mjs.
//
//   node dev/replay.mjs fixtures/demo.jsonl [--speed 4] [--until 48] [--port 4517]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [file, ...args] = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const speed = opt('--speed', 1);
const until = opt('--until', Infinity);
const port = opt('--port', 4517);

if (!file) {
  console.error('Запись не указана: node dev/replay.mjs fixtures/demo.jsonl [--speed 4] [--until 48] [--port 4517]');
  process.exit(1);
}

// {demo} в записи — папка проекта рядом с ней: fixtures/receipt-bot.jsonl → fixtures/receipt-bot.
// Так у демо есть настоящая папка со схемой .bybai/map.json.
const demo = resolve(file.replace(/\.jsonl$/, '')).replace(/\\/g, '/');
const rows = readFileSync(file, 'utf8').replaceAll('{demo}', demo)
  .split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)).slice(0, until);

for (const row of rows) {
  await new Promise((r) => setTimeout(r, row.dt / speed));
  const res = await fetch(`http://127.0.0.1:${port}/hook/${row.source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row.body),
  }).catch(() => null);
  if (res?.status !== 204) {
    console.error(res ? `Слушатель ответил ${res.status}` : `На порту ${port} никто не слушает: откройте ΒybAi или запустите dev/bridge.mjs`);
    process.exit(1);
  }
}
console.log(`Отправлено хуков: ${rows.length}, порт ${port}`);
