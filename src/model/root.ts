// Корневое состояние окна: сессии агентов и то, что набежало по хукам с запуска.
import { MAP_FILE, MAP_RULES, isMapCommand } from '../map/prompt';
import { normalizeClaude } from './claude';
import { normalizeCodex } from './codex';
import { emptyState, reduce } from './reduce';
import type { Envelope, Source, State } from './types';

/** Счётчики одной сессии с запуска окна. Сессия числится за проектом, в папке которого она сейчас. */
export interface Counters {
  agent: Source;
  cwd: string;
  transcript?: string;   // журнал сессии: путь присылает хук Claude Code
  firstAt: number;
  lastAt: number;
  actions: number;       // завершённые действия
  errors: number;        // из них с ошибкой
  workMs: number;        // сколько длились ходы агента
  mapChars: number;      // символы, ушедшие на схему: правила навыка и записанный файл
  replied: number;       // байты, которые слушатель вернул агенту
}

export interface Root {
  model: State;
  events: number;        // сколько хуков принято
  counters: Record<string, Counters>;
}

export const start: Root = { model: emptyState, events: 0, counters: {} };

/** Длина строки; у свёрнутой слушателем строки она хранится в поле chars. */
const size = (v: unknown): number =>
  typeof v === 'string' ? v.length : Number((v as { chars?: number } | null)?.chars ?? 0);

/** Сколько символов этот хук добавил к стоимости схемы: запрос на неё или запись её файла. */
function mapChars(b: Record<string, any>): number {
  if (b.hook_event_name === 'UserPromptSubmit') {
    const prompt = String(b.prompt ?? '');
    // Навык вызван командой: правила агент получает из файла навыка, в самом запросе их нет.
    if (isMapCommand(prompt)) return MAP_RULES.length + prompt.length;
    return prompt.includes(MAP_FILE) ? size(b.prompt) : 0;
  }
  if (b.hook_event_name !== 'PreToolUse' || typeof b.tool_input !== 'object' || b.tool_input === null) return 0;
  const input = b.tool_input as Record<string, unknown>;
  const path = String(input.file_path ?? '').replace(/\\/g, '/');
  if (path.endsWith(MAP_FILE)) return size(input.content ?? input.new_string);
  return b.tool_name === 'apply_patch' && String(input.command ?? '').includes(MAP_FILE) ? size(input.command) : 0;
}

export function root(r: Root, env: Envelope | 'reset'): Root {
  if (env === 'reset') return start;
  const body = (typeof env.body === 'object' && env.body !== null ? env.body : {}) as Record<string, any>;
  let { model, counters } = r;
  for (const ev of env.source === 'codex' ? normalizeCodex(env) : normalizeClaude(env)) {
    const before = model.sessions[ev.sid];
    model = reduce(model, ev);
    const c = counters[ev.sid]
      ?? { agent: ev.source, cwd: '', firstAt: ev.at, lastAt: ev.at, actions: 0, errors: 0, workMs: 0, mapChars: 0, replied: 0 };
    const turn = ev.t === 'stop' && before?.prompt && before.state !== 'idle' ? ev.at - before.prompt.at : 0;
    counters = {
      ...counters,
      [ev.sid]: {
        ...c,
        cwd: ev.cwd ?? c.cwd,
        lastAt: ev.at,
        transcript: typeof body.transcript_path === 'string' ? body.transcript_path : c.transcript,
        actions: c.actions + Number(ev.t === 'end'),
        errors: c.errors + Number(ev.t === 'end' && !ev.ok),
        workMs: c.workMs + turn,
      },
    };
  }
  // Стоимость схемы и ответы на хуки относятся к сессии, от которой пришёл хук.
  const mine = counters[String(body.session_id ?? '')];
  if (mine) {
    counters = {
      ...counters,
      [String(body.session_id)]: { ...mine, mapChars: mine.mapChars + mapChars(body), replied: mine.replied + env.replied },
    };
  }
  return { model, events: r.events + 1, counters };
}
