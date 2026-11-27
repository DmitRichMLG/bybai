// Статистика проектов: что хранится по сессиям и как это складывается в проект.
// Хранится в ~/.bybai/projects.json; в папку проекта ничего не пишется.
import type { Counters } from './model/root';
import type { Source } from './model/types';

/** Токены агента: вход без кэша, кэш (чтение и запись), выход. */
export interface Usage {
  input: number;
  cache: number;
  output: number;
}

/** Лимиты подписки: окна с долей расхода в процентах. Нет подписки — нет лимитов. */
export interface Limits {
  windows: { minutes: number; used: number; resets?: number | null }[];
  plan?: string | null;
}

/** Расход сессии из её журнала. Дни — номера от 1970-01-01 по местному времени. */
export interface UsageReply extends Usage {
  days: Record<string, number>;
  limits: Limits | null;
}

export interface SessionStat {
  agent: Source;
  firstAt: number;
  lastAt: number;
  usage: Usage;
  days: Record<string, number>;
  actions: number;
  errors: number;
  workMs: number;
  mapChars: number;
  replied: number;
}

export interface ProjectStat {
  path: string;
  lastAt: number;
  sessions: Record<string, SessionStat>;
}

export interface Store {
  projects: Record<string, ProjectStat>;
}

export const emptyStore: Store = { projects: {} };

/** Ключ проекта: его папка без различий в слэшах и регистре. */
export const projectKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function parseStore(text: string | null): Store {
  try {
    const raw = JSON.parse(text ?? '');
    return raw && typeof raw.projects === 'object' && raw.projects !== null ? { projects: raw.projects } : emptyStore;
  } catch {
    return emptyStore;
  }
}

const ZERO: Usage = { input: 0, cache: 0, output: 0 };

/**
 * Сохранённое при запуске плюс то, что набежало с тех пор. Считается всегда от base,
 * поэтому повторный вызов ничего не удваивает.
 * @param added папки, открытые вручную, ещё без сессий
 */
export function merge(
  base: Store, counters: Record<string, Counters>, usage: Record<string, UsageReply>, added: Record<string, ProjectStat> = {},
): Store {
  const projects: Record<string, ProjectStat> = {};
  const saved = new Map<string, SessionStat>();
  // Сессия числится за одним проектом — тем, где она сейчас: из остальных её убираем.
  for (const [key, p] of Object.entries(base.projects)) {
    const sessions: Record<string, SessionStat> = {};
    for (const [sid, s] of Object.entries(p.sessions ?? {})) {
      if (counters[sid]?.cwd) saved.set(sid, s);
      else sessions[sid] = s;
    }
    projects[key] = { path: p.path, lastAt: p.lastAt, sessions };
  }
  for (const [key, p] of Object.entries(added)) projects[key] ??= { ...p, sessions: {} };
  for (const [sid, c] of Object.entries(counters)) {
    if (!c.cwd) continue;
    const key = projectKey(c.cwd);
    const p = projects[key] ?? { path: c.cwd, lastAt: 0, sessions: {} };
    const old = saved.get(sid);
    const u = usage[sid];
    p.sessions[sid] = {
      agent: c.agent,
      firstAt: old?.firstAt ?? c.firstAt,
      lastAt: c.lastAt,
      usage: u ? { input: u.input, cache: u.cache, output: u.output } : old?.usage ?? ZERO,
      days: u?.days ?? old?.days ?? {},
      actions: (old?.actions ?? 0) + c.actions,
      errors: (old?.errors ?? 0) + c.errors,
      workMs: (old?.workMs ?? 0) + c.workMs,
      mapChars: (old?.mapChars ?? 0) + c.mapChars,
      replied: (old?.replied ?? 0) + c.replied,
    };
    projects[key] = { ...p, path: c.cwd, lastAt: Math.max(p.lastAt, c.lastAt) };
  }
  return { projects };
}

export const total = (u: Usage): number => u.input + u.cache + u.output;

export interface Sum {
  usage: Usage;
  total: number;
  byAgent: Record<Source, number>;
  sessions: number;
  actions: number;
  errors: number;
  workMs: number;
  mapChars: number;
  replied: number;
  days: Record<string, number>;
}

export function sum(p: ProjectStat | undefined): Sum {
  const out: Sum = {
    usage: { ...ZERO }, total: 0, byAgent: { claude: 0, codex: 0 },
    sessions: 0, actions: 0, errors: 0, workMs: 0, mapChars: 0, replied: 0, days: {},
  };
  for (const s of Object.values(p?.sessions ?? {})) {
    out.usage.input += s.usage.input;
    out.usage.cache += s.usage.cache;
    out.usage.output += s.usage.output;
    out.byAgent[s.agent] += total(s.usage);
    out.sessions++;
    out.actions += s.actions;
    out.errors += s.errors;
    out.workMs += s.workMs;
    out.mapChars += s.mapChars;
    out.replied += s.replied;
    for (const [day, n] of Object.entries(s.days)) out.days[day] = (out.days[day] ?? 0) + n;
  }
  out.total = total(out.usage);
  return out;
}

// ── Подписи ──────────────────────────────────────────────────────

/** 950 → «950», 184 200 → «184,2 тыс.», 1 240 000 → «1,24 млн». */
export function short(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(1).replace('.', ',')} тыс.`;
  return `${(n / 1e6).toFixed(2).replace('.', ',')} млн`;
}

/** Сколько минут прибавить к UTC, чтобы получить местное время. */
export const tzMinutes = (): number => -new Date().getTimezoneOffset();

/** Номер местного дня от 1970-01-01: в тех же единицах, что и дни в расходе сессии. */
export const dayOf = (at: number, tz = tzMinutes()): number => Math.floor((at + tz * 60000) / 86400000);

/** Когда проект был в работе: «сегодня», «вчера», «3 дня назад», «12 ноября». */
export function ago(at: number, now = Date.now()): string {
  const days = dayOf(now) - dayOf(at);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${days < 5 ? 'дня' : 'дней'} назад`;
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** 8 040 000 → «2 ч 14 мин». */
export function span(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'меньше минуты';
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

/** Окно лимита: 300 → «5ч», 10080 → «7д». */
export const windowName = (minutes: number): string => (minutes >= 1440 ? `${Math.round(minutes / 1440)}д` : `${Math.round(minutes / 60)}ч`);

/** «5ч 42% · 7д 18%» */
export const limitsText = (l: Limits): string => l.windows.map((w) => `${windowName(w.minutes)} ${Math.round(w.used)}%`).join(' · ');
