import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeClaude } from './claude';
import { normalizeCodex } from './codex';
import { emptyState, reduce } from './reduce';
import { lanes, turnActions } from './select';
import type { Envelope, Session, State } from './types';
import { diffLines, plural, rel } from './util';

const SID = 'demo-claude-1';
const rows: { dt: number; source: 'claude' | 'codex'; body: unknown }[] = readFileSync('fixtures/demo.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((s) => JSON.parse(s));

/** В записи сначала идёт короткая сессия Codex, затем сессия Claude Code. */
const CX = rows.findIndex((r) => r.source === 'claude');

/** Состояние после первых n хуков записи. */
function all(n: number): State {
  let state: State = emptyState;
  let at = 1_000_000;
  rows.slice(0, n).forEach((row, i) => {
    at += row.dt;
    const env: Envelope = { seq: i + 1, at, source: row.source, replied: 0, body: row.body };
    state = (row.source === 'codex' ? normalizeCodex(env) : normalizeClaude(env)).reduce(reduce, state);
  });
  return state;
}

/** Сессия Claude Code после первых n её хуков. */
const play = (n: number): Session => all(CX + n).sessions[SID];

const claude = (body: object) =>
  normalizeClaude({ seq: 1, at: 5, source: 'claude', replied: 0, body: { session_id: 's', cwd: 'C:\\p', ...body } });

describe('util', () => {
  it('считает только изменённые строки', () => {
    expect(diffLines('a\nb\n', 'a\nx\ny\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
    expect(diffLines('one', 'two')).toEqual({ added: 1, removed: 1 });
    expect(diffLines('', 'a\nb')).toEqual({ added: 2, removed: 0 });
  });
  it('берёт число строк свёрнутой строки как есть', () => {
    expect(diffLines('a', { $trim: true, chars: 9000, lines: 120, head: 'x' })).toEqual({ added: 120, removed: 1 });
  });
  it('склоняет числительные', () => {
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, 'файл', 'файла', 'файлов')))
      .toEqual(['1 файл', '2 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '112 файлов']);
  });
  it('делает путь относительным без учёта регистра диска', () => {
    expect(rel('c:\\P\\src\\a.ts', 'C:\\p')).toBe('src/a.ts');
    expect(rel('D:\\other\\a.ts', 'C:\\p')).toBe('D:/other/a.ts');
  });
});

describe('хуки Claude Code', () => {
  it('правка: цель, счётчик строк и изменённый файл', () => {
    const [ev] = claude({
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't1',
      tool_input: { file_path: 'C:\\p\\src\\a.ts', old_string: 'x\n', new_string: 'x\ny\n' },
    });
    expect(ev).toMatchObject({
      t: 'start', id: 't1', kind: 'edit', target: 'src/a.ts', note: '+1',
      files: [{ path: 'src/a.ts', added: 1, removed: 0 }], sid: 's', source: 'claude', at: 5,
    });
  });
  it('упавшая команда: код выхода и причина без служебной строки', () => {
    const [ev] = claude({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't2', error: 'Exit code 2\nboom\nmore' });
    expect(ev).toMatchObject({ t: 'end', id: 't2', ok: false, note: 'код 2', error: 'boom' });
  });
  it('список дел превращается в план', () => {
    const [ev] = claude({
      hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_use_id: 't3',
      tool_input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] },
    });
    expect(ev).toMatchObject({ t: 'plan', steps: [{ text: 'A', status: 'done' }, { text: 'B', status: 'running' }, { text: 'C', status: 'pending' }] });
  });
  it('задачи: создание даёт шаг, обновление меняет статус', () => {
    const made = claude({
      hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_use_id: 't4',
      tool_input: { subject: 'Шаг' }, tool_response: { task: { id: '7', subject: 'Шаг' } },
    });
    expect(made[0]).toMatchObject({ t: 'step', id: '7', text: 'Шаг', status: 'pending' });
    const moved = claude({ hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_use_id: 't5', tool_input: { taskId: '7', status: 'in_progress' } });
    expect(moved).toMatchObject([{ t: 'step', id: '7', status: 'running' }]);
  });
  it('запрос разрешения переводит в ожидание, прочие уведомления пропускаются', () => {
    expect(claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Нужно разрешение' }))
      .toMatchObject([{ t: 'waiting', text: 'Нужно разрешение' }]);
    expect(claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x' })).toEqual([]);
  });
  it('mcp и неизвестные инструменты не теряются', () => {
    expect(claude({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me', tool_use_id: 'a', tool_input: {} })[0])
      .toMatchObject({ kind: 'mcp', target: 'github · get_me' });
    expect(claude({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'b', tool_input: {} })[0])
      .toMatchObject({ kind: 'other', target: 'Skill' });
  });
  it('тело без session_id игнорируется', () => {
    expect(normalizeClaude({ seq: 1, at: 1, source: 'claude', replied: 0, body: { hook_event_name: 'Stop' } })).toEqual([]);
  });
});

describe('демосессия', () => {
  it('контрольный кадр: 35 хуков', () => {
    const s = play(35);
    expect(s.state).toBe('running');
    expect(s.prompt?.text).toBe('Добавить экспорт отчёта в CSV');
    expect(s.steps.map((x) => x.status)).toEqual(['done', 'done', 'running', 'pending', 'pending']);
    expect(turnActions(s)).toHaveLength(15);

    const view = lanes(s);
    expect(view.map((l) => [l.n, l.title, l.status])).toEqual([
      ['·', 'До плана', 'done'],
      ['1', 'Изучить модуль отчётов', 'done'],
      ['2', 'Добавить сериализатор CSV', 'done'],
      ['3', 'Написать тесты экспорта', 'running'],
    ]);
    expect(view[0].chips.map((c) => [c.kind, c.target, c.note])).toEqual([
      ['search', 'report', '14 файлов'],
      ['read', '3 файла', undefined],
      ['plan', '5 шагов', undefined],
    ]);
    expect(view[1].chips.map((c) => c.target)).toEqual(['src/report/format.ts', 'src/cli.ts', 'toJSON']);
    expect(view[3].chips.map((c) => [c.kind, c.target, c.note, c.status])).toEqual([
      ['write', 'test/csv.test.ts', '+48', 'done'],
      ['command', 'npm test -- csv', 'код 1', 'failed'],
      ['edit', 'src/report/csv.ts', '+3 −1', 'done'],
      ['command', 'npm test -- csv', undefined, 'running'],
    ]);
    expect(view[3].error).toContain('экранирует кавычки');
    expect(s.files).toEqual([
      { path: 'src/report/csv.ts', added: 67, removed: 1, created: true },
      { path: 'src/report/index.ts', added: 2, removed: 0, created: false },
      { path: 'test/csv.test.ts', added: 48, removed: 0, created: true },
    ]);
  });

  it('запрос разрешения: сессия и действие ждут человека', () => {
    const at = rows.findIndex((r) => (r.body as any).hook_event_name === 'Notification') + 1 - CX;
    const s = play(at);
    expect(s.state).toBe('waiting');
    expect(s.actions[s.actions.length - 1]).toMatchObject({ target: 'npm link', status: 'waiting' });
    expect(lanes(s).pop()?.status).toBe('waiting');
    expect(play(at + 1).state).toBe('running');
  });

  it('финал: план выполнен, ход завершён', () => {
    const s = play(rows.length - CX);
    expect(s.state).toBe('idle');
    expect(s.steps.every((x) => x.status === 'done')).toBe(true);
    expect(s.actions.every((a) => a.status === 'done' || a.status === 'failed')).toBe(true);
    expect(lanes(s)).toHaveLength(6);
    expect(s.files.map((f) => f.path)).toEqual(['src/report/csv.ts', 'src/report/index.ts', 'test/csv.test.ts', 'src/cli.ts', 'README.md']);
  });
});

describe('хуки Codex', () => {
  const codex = (body: object) =>
    normalizeCodex({ seq: 1, at: 5, source: 'codex', replied: 0, body: { session_id: 'c', cwd: 'C:\\p', ...body } });

  it('update_plan превращается в план', () => {
    const [ev] = codex({
      hook_event_name: 'PreToolUse', tool_name: 'update_plan', tool_use_id: 'c1',
      tool_input: { plan: [{ step: 'A', status: 'completed' }, { step: 'B', status: 'in_progress' }] },
    });
    expect(ev).toMatchObject({ t: 'plan', id: 'c1', source: 'codex', steps: [{ text: 'A', status: 'done' }, { text: 'B', status: 'running' }] });
  });
  it('патч: файлы, новые файлы и число строк', () => {
    const patch = ['*** Begin Patch', '*** Add File: src/new.ts', '+a', '+b', '*** Update File: C:\\p\\src\\old.ts', '@@', '-x', '+y', '+z', '*** End Patch', ''].join('\n');
    const [ev] = codex({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'c2', tool_input: { command: patch } });
    expect(ev).toMatchObject({
      t: 'start', kind: 'edit', target: '2 файла', note: '+4 −1',
      files: [{ path: 'src/new.ts', added: 2, removed: 0, created: true }, { path: 'src/old.ts', added: 2, removed: 1, created: false }],
    });
  });
  it('команда с ненулевым кодом считается упавшей', () => {
    const bad = codex({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c3', tool_response: 'Process exited with code 2\nOutput:\nboom' });
    expect(bad).toMatchObject([{ t: 'end', id: 'c3', ok: false, note: 'код 2', error: 'boom' }]);
    const ok = codex({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c4', tool_response: 'Process exited with code 0\nOutput:\nfine' });
    expect(ok).toMatchObject([{ t: 'end', id: 'c4', ok: true }]);
  });
  it('демосессия Codex: план выполнен, файл изменён, ход завершён', () => {
    const s = all(CX).sessions['demo-codex-1'];
    expect(s).toMatchObject({ source: 'codex', state: 'idle', cwd: 'C:\\work\\landing' });
    expect(s.steps.map((x) => x.status)).toEqual(['done', 'done']);
    expect(lanes(s).map((l) => [l.n, l.title, l.chips.map((c) => c.target)])).toEqual([
      ['·', 'До плана', ['2 шага']],
      ['1', 'Найти стили шапки', ['rg -n "header" src/styles']],
      ['2', 'Исправить отступы', ['src/styles/header.css']],
    ]);
    expect(s.files).toEqual([{ path: 'src/styles/header.css', added: 2, removed: 1, created: false }]);
  });
});

describe('состояние', () => {
  it('завершение, пришедшее раньше начала, не теряется', () => {
    let state: State = emptyState;
    const feed = (body: object, at: number) => {
      state = normalizeCodex({ seq: at, at, source: 'codex', replied: 0, body: { session_id: 'r', cwd: '/p', ...body } }).reduce(reduce, state);
    };
    feed({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'q', tool_response: 'ok' }, 1);
    feed({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'q', tool_input: { command: 'ls' } }, 2);
    expect(state.sessions.r.actions).toMatchObject([{ id: 'q', target: 'ls', status: 'done' }]);
    expect(state.sessions.r.early).toEqual([]);
  });
  it('повторная пересылка того же плана не создаёт действие', () => {
    const s = play(20);
    expect(s.actions.filter((a) => a.kind === 'plan')).toHaveLength(1);
  });
  it('незавершённые действия закрываются при остановке', () => {
    let state: State = emptyState;
    const feed = (body: object, at: number) => {
      state = normalizeClaude({ seq: at, at, source: 'claude', replied: 0, body: { session_id: 'x', cwd: '/p', ...body } }).reduce(reduce, state);
    };
    feed({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'sleep 9' } }, 1);
    feed({ hook_event_name: 'Stop' }, 2);
    expect(state.sessions.x.actions[0]).toMatchObject({ status: 'done', note: 'прервано', endedAt: 2 });
    expect(state.sessions.x.state).toBe('idle');
  });
});

// Настоящие хуки Claude Code 2.1.332, записанные мостом; пути заменены нейтральными.
describe('живая запись Claude Code', () => {
  const live: { dt: number; body: unknown }[] = readFileSync('fixtures/claude-live.jsonl', 'utf8')
    .split(/\r?\n/).filter(Boolean).map((s: string) => JSON.parse(s));
  let state: State = emptyState;
  let at = 2_000_000;
  live.forEach((row, i) => {
    at += row.dt;
    state = normalizeClaude({ seq: i + 1, at, source: 'claude', replied: 0, body: row.body }).reduce(reduce, state);
  });

  it('задачи становятся планом, а отклонённая команда не остаётся идущей', () => {
    const s = state.sessions['live-claude-1'];
    expect(s.state).toBe('closed');
    expect(s.steps.map((x) => [x.id, x.status])).toEqual([['1', 'done'], ['2', 'pending'], ['3', 'done'], ['4', 'done']]);
    expect(lanes(s).map((l) => [l.n, l.chips.map((c) => [c.kind, c.target, c.note])])).toEqual([
      ['·', [['plan', '4 шага', undefined]]],
      ['1', [['write', 'hello.txt', '+2']]],
      ['2', [['command', 'node -e "process.exit(3)"', 'нет результата']]],
      ['3', [['read', 'hello.txt', undefined]]],
      ['4', [['edit', 'hello.txt', '+2 −1']]],
    ]);
    expect(s.files).toEqual([{ path: 'hello.txt', added: 4, removed: 1, created: true }]);
  });

  it('вызовы без разрешения закрыты к концу хода', () => {
    const s = state.sessions['live-claude-2'];
    expect(s.actions).toHaveLength(3);
    expect(s.actions.every((a) => a.status === 'done')).toBe(true);
  });

  it('упавшая команда: код выхода и причина', () => {
    expect(state.sessions['live-claude-3'].actions)
      .toMatchObject([{ kind: 'command', status: 'failed', note: 'код 3', error: 'boom' }]);
  });
});

describe('вкладки', () => {
  it('лишние сессии уходят: сначала закрытые, работающие остаются', () => {
    let state: State = emptyState;
    const feed = (sid: string, body: object, at: number) => {
      state = normalizeClaude({ seq: at, at, source: 'claude', replied: 0, body: { session_id: sid, cwd: '/p', ...body } }).reduce(reduce, state);
    };
    feed('busy', { hook_event_name: 'UserPromptSubmit', prompt: 'работа' }, 1);
    for (let i = 0; i < 7; i++) feed(`idle-${i}`, { hook_event_name: 'Stop' }, 10 + i);
    feed('idle-0', { hook_event_name: 'SessionEnd' }, 30);   // закрыта позже всех, но закрытые уходят первыми
    expect(state.order).toHaveLength(8);
    feed('new-1', { hook_event_name: 'UserPromptSubmit', prompt: 'ещё' }, 40);
    expect(state.order).toEqual(['busy', 'idle-1', 'idle-2', 'idle-3', 'idle-4', 'idle-5', 'idle-6', 'new-1']);
    feed('new-2', { hook_event_name: 'UserPromptSubmit', prompt: 'ещё' }, 41);
    expect(state.order).toEqual(['busy', 'idle-2', 'idle-3', 'idle-4', 'idle-5', 'idle-6', 'new-1', 'new-2']);
    expect(Object.keys(state.sessions)).toHaveLength(8);
  });
});
