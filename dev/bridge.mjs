// Мост для разработки: делает то же, что слушатель внутри окна Tauri, но на Node.
// Принимает хуки на POST /hook/<агент> и раздаёт их странице через SSE /events.
//
//   node dev/bridge.mjs                              слушать живые сессии
//   node dev/bridge.mjs --record out.jsonl           ещё и записывать принятое
//   node dev/bridge.mjs --port 4599                  другой порт; страницу открыть с ?bridge=4599
//
// Запись проигрывает dev/replay.mjs — и сюда, и в окно приложения.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const DEFAULT_PORT = 4517;
// Длинные строки сворачиваются; то же правило в src-tauri. В tool_input лежат патчи и
// содержимое файлов, по которым считаются строки, поэтому там порог выше.
const TRIM_RESPONSE = 2048;
const TRIM_OTHER = 65536;
const HEAD = 300;
const BACKLOG = 5000;

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const record = opt('--record');
const PORT = Number(opt('--port') ?? DEFAULT_PORT);

const boot = Date.now().toString(36);
const backlog = [];
const clients = new Set();
let seq = 0;
let lastAt = Date.now();

function trim(v, limit) {
  if (typeof v === 'string') {
    if (v.length <= limit) return v;
    const lines = v.split('\n').length - (v.endsWith('\n') ? 1 : 0);
    return { $trim: true, chars: v.length, lines, head: v.slice(0, HEAD) };
  }
  if (Array.isArray(v)) return v.map((x) => trim(x, limit));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, limit)]));
  return v;
}

/** Ответ инструмента сворачиваем сразу, остальное — только если оно огромное. */
function trimBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return trim(body, TRIM_OTHER);
  return Object.fromEntries(
    Object.entries(body).map(([k, x]) => [k, trim(x, k === 'tool_response' ? TRIM_RESPONSE : TRIM_OTHER)]),
  );
}

function accept(source, body) {
  const at = Date.now();
  if (record) appendFileSync(record, JSON.stringify({ dt: at - lastAt, source, body }) + '\n');
  lastAt = at;
  // replied: 0 — ответ на хук всегда пустой, агенту не уходит ни байта.
  const env = { seq: ++seq, at, source, replied: 0, body };
  backlog.push(env);
  if (backlog.length > BACKLOG) backlog.shift();
  for (const res of clients) res.write(`data: ${JSON.stringify(env)}\n\n`);
}

const local = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');

createServer((req, res) => {
  const hook = /^\/hook\/(claude|codex)$/.exec(req.url ?? '');
  if (req.method === 'POST' && hook) {
    // Страница из браузера всегда шлёт Origin; хуки агентов — никогда.
    if (req.headers.origin) return void res.writeHead(403).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        accept(hook[1], trimBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch {
        // не JSON — пропускаем
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/events' && local(req.headers.origin)) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': req.headers.origin,
    });
    res.write(`event: boot\ndata: ${boot}\n\n`);
    for (const env of backlog) res.write(`data: ${JSON.stringify(env)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ΒybAi bridge: http://127.0.0.1:${PORT}`);
});
