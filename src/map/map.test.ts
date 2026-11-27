import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeClaude } from '../model/claude';
import { emptyState, reduce } from '../model/reduce';
import type { State } from '../model/types';
import { NODE_H, NODE_W, layout } from './layout';
import { live } from './live';
import { matcher, parseMap, reach } from './spec';

const text = readFileSync('fixtures/receipt-bot/.bybai/map.json', 'utf8');
const map = parseMap(text).map!;
const BACKSLASH = String.fromCharCode(92);

describe('файл схемы', () => {
  it('демосхема разбирается без ошибок', () => {
    expect(parseMap(text).errors).toEqual([]);
    expect(map.nodes).toHaveLength(11);
    expect(map.edges).toHaveLength(10);
    expect(map.groups.map((g) => g.id)).toEqual(['chat', 'bot', 'outside', 'checks']);
  });

  it('ошибки называют узел и причину', () => {
    const bad = JSON.stringify({
      nodes: [
        { id: 'a', kind: 'service', label: 'А' },
        { id: 'a', kind: 'service', label: 'Дубль' },
        { id: 'B!', kind: 'service', label: 'Плохой id' },
        { id: 'c', kind: 'robot', label: 'Очень длинное название узла схемы', group: 'нет' },
      ],
      edges: [{ from: 'a', to: 'zzz' }, { from: 'a', to: 'a' }, { from: 'a' }],
    });
    const { map: none, errors } = parseMap(bad);
    expect(none).toBeUndefined();
    expect(errors.join('\n')).toMatch(/Узел «a» объявлен дважды/);
    expect(errors.join('\n')).toMatch(/id должен состоять из латинских букв/);
    expect(errors.join('\n')).toMatch(/Узел c: kind должен быть одним из/);
    expect(errors.join('\n')).toMatch(/группа «нет» не объявлена/);
    expect(errors.join('\n')).toMatch(/длиннее 22 символов/);
    expect(errors.join('\n')).toMatch(/узла «zzz» нет/);
    expect(errors.join('\n')).toMatch(/не может ссылаться сам на себя/);
    expect(errors.join('\n')).toMatch(/должны быть from и to/);
  });

  it('не JSON и пустая схема — понятные ошибки', () => {
    expect(parseMap('{ nodes: ').errors[0]).toMatch(/не является JSON/);
    expect(parseMap('[]').errors[0]).toMatch(/В корне должен быть объект/);
    expect(parseMap('{}').errors[0]).toMatch(/хотя бы один узел/);
  });
});

describe('узел по файлу и команде', () => {
  const m = matcher(map);
  it('шаблоны путей', () => {
    expect(m.file('bot/handlers/receipt.py')).toBe('intake');
    expect(m.file('bot/rules.py')).toBe('rules');
    expect(m.file('promo.yaml')).toBe('promo');
    expect(m.file('migrations/001_init.sql')).toBe('db');
    expect(m.file('README.md')).toBeUndefined();
    expect(m.file(['bot', 'qr.py'].join(BACKSLASH))).toBe('qr');
  });
  it('побеждает самый длинный шаблон', () => {
    const two = matcher(parseMap(JSON.stringify({
      nodes: [
        { id: 'all', kind: 'service', label: 'Всё', files: ['src/**'] },
        { id: 'api', kind: 'service', label: 'API', files: ['src/api/**'] },
      ],
      edges: [],
    })).map!);
    expect(two.file('src/api/users.ts')).toBe('api');
    expect(two.file('src/util.ts')).toBe('all');
  });
  it('команда относится к узлу по фрагменту', () => {
    expect(m.command('pytest -q')).toBe('tests');
    expect(m.command('python -m PYTEST tests')).toBe('tests');
    expect(m.command('git status')).toBeUndefined();
  });
});

describe('достижимость', () => {
  it('откуда и куда', () => {
    expect([...reach(map, 'registry', 'up')].sort()).toEqual(['intake', 'promo', 'purchase', 'qr', 'rules', 'telegram']);
    expect([...reach(map, 'rules', 'down')].sort()).toEqual(['db', 'registry', 'replies']);
    expect(reach(map, 'tests', 'down').size).toBe(0);
  });
  it('цикл не зацикливает обход', () => {
    const loop = parseMap(JSON.stringify({
      nodes: [{ id: 'a', kind: 'service', label: 'A' }, { id: 'b', kind: 'service', label: 'B' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    })).map!;
    expect([...reach(loop, 'a', 'down')]).toEqual(['b']);
    expect(layout(loop).boxes).toHaveLength(2);
  });
});

describe('раскладка', () => {
  const lay = layout(map);
  it('узлы не накладываются и лежат внутри холста', () => {
    expect(lay.boxes).toHaveLength(11);
    for (const a of lay.boxes) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + NODE_W).toBeLessThanOrEqual(lay.w);
      expect(a.y + NODE_H).toBeLessThanOrEqual(lay.h);
      for (const b of lay.boxes) {
        if (a === b) continue;
        const apart = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
        expect(apart, `${a.id} и ${b.id}`).toBe(true);
      }
    }
  });
  it('у каждой группы своя рамка, у каждой связи — линия', () => {
    expect(lay.bands.map((b) => b.id)).toEqual(['chat', 'bot', 'outside', 'checks']);
    expect(lay.wires).toHaveLength(10);
    expect(lay.wires.every((w) => /^M[\d.]+ [\d.]+ [CL]/.test(w.d))).toBe(true);
  });
  it('длинная цепочка раскладывается сверху вниз, короткая — слева направо', () => {
    expect(lay.h).toBeGreaterThan(lay.w * 0.6);
    const short = layout(parseMap(JSON.stringify({
      nodes: [{ id: 'a', kind: 'client', label: 'A' }, { id: 'b', kind: 'service', label: 'B' }, { id: 'c', kind: 'data', label: 'C' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    })).map!);
    const at = (id: string) => short.boxes.find((b) => b.id === id)!;
    expect(at('b').x).toBeGreaterThan(at('a').x);
    expect(at('b').y).toBe(at('a').y);
  });
});

describe('живая подсветка', () => {
  const rows: { dt: number; body: unknown }[] = readFileSync('fixtures/receipt-bot.jsonl', 'utf8')
    .replaceAll('{demo}', 'C:/demo').split(/\r?\n/).filter(Boolean).map((s: string) => JSON.parse(s));
  const play = (n: number) => {
    let state: State = emptyState;
    let at = 1_000_000;
    rows.slice(0, n).forEach((row, i) => {
      at += row.dt;
      state = normalizeClaude({ seq: i + 1, at, source: 'claude', replied: 0, body: row.body }).reduce(reduce, state);
    });
    return { session: state.sessions['demo-receipt-bot'], at };
  };

  it('контрольный кадр: тесты идут, правки посчитаны по узлам', () => {
    const { session, at } = play(31);
    // через три секунды после запуска тестов: недавняя правка уже погасла, тесты ещё идут
    const lv = live(session, matcher(map), at + 3000);
    expect(lv.stray).toBe(0);
    expect(lv.nodes.get('tests')).toMatchObject({ active: true, failed: false });
    expect(lv.nodes.get('replies')).toMatchObject({ edits: 2, active: false });
    expect(lv.nodes.get('registry')).toMatchObject({ edits: 1, reads: 1 });
    expect(lv.nodes.get('intake')).toMatchObject({ edits: 1, reads: 1 });
    expect(lv.nodes.has('db')).toBe(false);
  });

  it('упавшие тесты помечают узел, пока не пройдут', () => {
    const failedAt = rows.findIndex((r) => (r.body as any).hook_event_name === 'PostToolUseFailure') + 1;
    const { session, at } = play(failedAt);
    expect(live(session, matcher(map), at + 60_000).nodes.get('tests')).toMatchObject({ failed: true, active: false });
    const end = play(rows.length);
    expect(live(end.session, matcher(map), end.at + 60_000).nodes.get('tests')).toMatchObject({ failed: false, active: false });
  });

  it('подсветка гаснет через пару секунд после действия', () => {
    const { session, at } = play(6);   // прочитан bot/handlers/receipt.py
    expect(live(session, matcher(map), at).nodes.get('intake')?.active).toBe(true);
    expect(live(session, matcher(map), at + 5000).nodes.get('intake')?.active).toBe(false);
  });
});

// Схема, которую Claude Code (haiku) записал по запросу из приложения для пробного проекта.
describe('схема от настоящего агента', () => {
  it('разбирается без ошибок и раскладывается', () => {
    const { map: real, errors } = parseMap(readFileSync('fixtures/agent-map.json', 'utf8'));
    expect(errors).toEqual([]);
    expect(real!.nodes.length).toBeGreaterThanOrEqual(6);
    expect(layout(real!).boxes).toHaveLength(real!.nodes.length);
    expect(matcher(real!).file('src/web/cart.js')).toBe('web');
  });
});
