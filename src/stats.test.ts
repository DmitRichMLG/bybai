import { describe, expect, it } from 'vitest';
import { MAP_RULES } from './map/prompt';
import { root, start, type Counters, type Root } from './model/root';
import { lamp, progress } from './model/select';
import { DEFAULTS, parseSettings } from './settings';
import { ago, dayOf, limitsText, merge, parseStore, projectKey, short, span, sum, type Store, type UsageReply } from './stats';

/** Проигрывает хуки Claude Code одной сессии: время идёт по секунде на хук. */
function play(sid: string, cwd: string, hooks: Record<string, unknown>[], from: Root = start, t0 = 1000): Root {
  return hooks.reduce<Root>(
    (r, body, i) => root(r, {
      seq: r.events + 1, at: t0 + i * 1000, source: 'claude', replied: 0,
      body: { session_id: sid, cwd, transcript_path: `C:\\Users\\me\\.claude\\projects\\p\\${sid}.jsonl`, ...body },
    }),
    from,
  );
}

const TURN = [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt: '/bybmap' },
  { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'C:\\work\\Shop\\.bybai\\map.json', content: 'x'.repeat(300) } },
  { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_response: { type: 'create' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'pytest' } },
  { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', error: 'Exit code 1' },
  { hook_event_name: 'Stop' },
];

describe('счётчики сессии', () => {
  const r = play('s1', 'C:\\work\\Shop', TURN);

  it('считают действия, ошибки, время хода и стоимость схемы', () => {
    expect(r.events).toBe(7);
    expect(r.counters.s1).toEqual({
      agent: 'claude', cwd: 'C:\\work\\Shop', transcript: 'C:\\Users\\me\\.claude\\projects\\p\\s1.jsonl',
      firstAt: 1000, lastAt: 7000, actions: 2, errors: 1, workMs: 5000,
      // правила навыка, сама команда и записанный файл
      mapChars: MAP_RULES.length + '/bybmap'.length + 300, replied: 0,
    });
  });

  it('повторный Stop время хода не удваивает', () => {
    expect(play('s1', 'C:\\work\\Shop', [{ hook_event_name: 'Stop' }], r, 9000).counters.s1.workMs).toBe(5000);
  });

  it('фонарь: не начата, работает, нужен человек, готово', () => {
    const at = (n: number) => play('s1', 'C:\\work\\Shop', TURN.slice(0, n)).model.sessions.s1;
    expect(lamp(undefined)).toBe('idle');
    expect(lamp(at(1))).toBe('idle');          // сессия открыта, задачи ещё не было
    expect(lamp(at(3))).toBe('run');
    expect(lamp(at(7))).toBe('attn');          // ход закончился ошибкой
    expect(lamp(at(4))).toBe('run');
    const asked = play('s1', 'C:\\work\\Shop', [...TURN.slice(0, 5), { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Разрешить pytest?' }]);
    expect(lamp(asked.model.sessions.s1)).toBe('attn');
    const fine = play('s1', 'C:\\work\\Shop', [...TURN.slice(0, 4), { hook_event_name: 'Stop' }]);
    expect(lamp(fine.model.sessions.s1)).toBe('done');
  });

  it('процент — доля выполненных шагов плана', () => {
    const todo = (...status: string[]) => ({
      hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_use_id: 't', tool_input: { todos: status.map((s, i) => ({ content: `шаг ${i}`, status: s })) },
    });
    const s = play('s1', 'C:\\p', [TURN[1], todo('completed', 'in_progress', 'pending', 'pending')]).model.sessions.s1;
    expect(progress(s)).toBe(25);
    expect(progress(play('s1', 'C:\\p', [TURN[1]]).model.sessions.s1)).toBe(null);
  });
});

describe('статистика проекта', () => {
  const c = (cwd: string, more: Partial<Counters> = {}): Counters =>
    ({ agent: 'claude', cwd, firstAt: 500, lastAt: 900, actions: 3, errors: 1, workMs: 60000, mapChars: 900, replied: 0, ...more });
  const u = (input: number, cache: number, output: number, days: Record<string, number> = {}): UsageReply => ({ input, cache, output, days, limits: null });
  const base: Store = {
    projects: {
      'c:/work/shop': {
        path: 'C:\\work\\Shop', lastAt: 100,
        sessions: {
          old: { agent: 'codex', firstAt: 10, lastAt: 100, usage: { input: 5, cache: 50, output: 5 }, days: { 20783: 60 }, actions: 4, errors: 0, workMs: 1000, mapChars: 0, replied: 0 },
          s1: { agent: 'claude', firstAt: 20, lastAt: 90, usage: { input: 1, cache: 1, output: 1 }, days: { 20783: 3 }, actions: 10, errors: 2, workMs: 5000, mapChars: 300, replied: 0 },
        },
      },
    },
  };

  it('ключ проекта не зависит от слэшей и регистра', () => {
    expect(projectKey('C:\\Work\\Shop\\')).toBe('c:/work/shop');
    expect(projectKey('c:/work/shop')).toBe('c:/work/shop');
  });

  it('сохранённое складывается с тем, что набежало, и не удваивается', () => {
    const counters = { s1: c('C:\\work\\Shop') };
    const usage = { s1: u(10, 100, 20, { 20784: 130 }) };
    const once = merge(base, counters, usage);
    expect(merge(base, counters, usage)).toEqual(once);
    const p = once.projects['c:/work/shop'];
    expect(p.lastAt).toBe(900);
    // счётчики по хукам прибавляются к сохранённым, расход берётся из журнала целиком
    expect(p.sessions.s1).toMatchObject({ firstAt: 20, lastAt: 900, actions: 13, errors: 3, workMs: 65000, mapChars: 1200, usage: { input: 10, cache: 100, output: 20 }, days: { 20784: 130 } });
    expect(p.sessions.old).toEqual(base.projects['c:/work/shop'].sessions.old);

    const total = sum(p);
    expect(total).toMatchObject({ total: 190, usage: { input: 15, cache: 150, output: 25 }, byAgent: { claude: 130, codex: 60 }, sessions: 2, actions: 17, errors: 3, mapChars: 1200 });
    expect(total.days).toEqual({ 20783: 60, 20784: 130 });
    // журнал ещё не прочитан: остаётся сохранённый расход
    expect(sum(merge(base, counters, {}).projects['c:/work/shop']).total).toBe(63);
  });

  it('сессия числится за проектом, в папке которого она сейчас', () => {
    const moved = merge(base, { s1: c('D:\\other') }, {});
    expect(Object.keys(moved.projects['c:/work/shop'].sessions)).toEqual(['old']);
    expect(moved.projects['d:/other'].sessions.s1.actions).toBe(13);
    expect(moved.projects['d:/other'].path).toBe('D:\\other');
  });

  it('папка, открытая вручную, попадает в список без сессий', () => {
    const added = { 'd:/new': { path: 'D:\\new', lastAt: 777, sessions: {} } };
    expect(merge(base, {}, {}, added).projects['d:/new']).toEqual({ path: 'D:\\new', lastAt: 777, sessions: {} });
    expect(sum(undefined).total).toBe(0);
  });

  it('испорченный файл читается как пустой', () => {
    expect(parseStore(null)).toEqual({ projects: {} });
    expect(parseStore('{"projects":')).toEqual({ projects: {} });
    expect(parseStore(JSON.stringify(base))).toEqual(base);
  });

  it('подписи', () => {
    expect([short(950), short(184200), short(1240000)]).toEqual(['950', '184,2 тыс.', '1,24 млн']);
    expect([span(20000), span(14 * 60000), span(134 * 60000)]).toEqual(['меньше минуты', '14 мин', '2 ч 14 мин']);
    expect(limitsText({ windows: [{ minutes: 300, used: 41.6 }, { minutes: 10080, used: 18.2 }] })).toBe('5ч 42% · 7д 18%');
    const now = Date.UTC(2026, 10, 27, 12);
    expect(dayOf(now, 0)).toBe(20784);
    expect([ago(now, now), ago(now - 86400000, now), ago(now - 3 * 86400000, now)]).toEqual(['сегодня', 'вчера', '3 дня назад']);
  });
});

describe('настройки', () => {
  it('незнакомое заменяется значением по умолчанию', () => {
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings('не JSON')).toEqual(DEFAULTS);
    expect(parseSettings(JSON.stringify({ theme: 'neon', colors: { bg: 'red', live: '#00FF88' }, hud: { on: false, mode: 'click', corner: 'zz' }, tabs: ['a', 5] })))
      .toEqual({ theme: 'lime', colors: { live: '#00FF88' }, hud: { on: false, mode: 'click', corner: 'tl' }, tabs: ['a'] });
  });
});
