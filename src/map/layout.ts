// Раскладка схемы. Узлы встают по зависимостям вдоль главной оси, группы — полосами поперёк неё.
// Направление выбирается само: слева направо или сверху вниз — то, при котором схема крупнее в окне.
import type { MapSpec } from './spec';

export const NODE_W = 200;
export const NODE_H = 58;
const PAD = 36;          // поля холста
const BAND_PAD = 20;     // от рамки группы до узлов
const BAND_HEAD = 20;    // место под подпись группы
const BAND_GAP = 24;

type Dir = 'lr' | 'tb';
// m — размер узла и зазор вдоль главной оси, c — поперёк неё
const SIZE = {
  lr: { m: NODE_W, c: NODE_H, gm: 96, gc: 22 },
  tb: { m: NODE_H, c: NODE_W, gm: 40, gc: 30 },
};

export interface Box { id: string; x: number; y: number }
export interface Band { id: string; label: string; x: number; y: number; w: number; h: number }
export interface Wire { from: string; to: string; label?: string; d: string; lx: number; ly: number }
export interface Layout { w: number; h: number; boxes: Box[]; bands: Band[]; wires: Wire[] }

/** Раскладка под окно примерно такого размера. */
export function layout(map: MapSpec, view = { w: 1240, h: 640 }): Layout {
  const g = arrange(map);
  const fit = (l: Layout) => Math.min(1, view.w / l.w, view.h / l.h);
  const lr = place(map, g, 'lr');
  const tb = place(map, g, 'tb');
  return fit(tb) > fit(lr) + 0.03 ? tb : lr;
}

interface Arranged {
  ranks: number;
  rank: Map<string, number>;
  bands: string[];                              // '' — узлы без группы
  cell: (band: string, rank: number) => string[];
}

/** Порядок без координат: ранг каждого узла и порядок узлов в ячейке (группа, ранг). */
function arrange(map: MapSpec): Arranged {
  const ids = map.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));

  // Обратные связи (циклы) в расстановке по рангам не участвуют.
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of map.edges) {
      if (e.from !== id) continue;
      if (state.get(e.to) === 1) back.add(`${e.from}>${e.to}`);
      else if (!state.has(e.to)) visit(e.to);
    }
    state.set(id, 2);
  };
  ids.forEach((id) => state.has(id) || visit(id));
  for (const e of map.edges) {
    if (back.has(`${e.from}>${e.to}`)) continue;
    out.get(e.from)!.push(e.to);
    inc.get(e.to)!.push(e.from);
  }

  // Ранг узла — самый длинный путь до него.
  const rank = new Map<string, number>();
  const depth = (id: string): number => {
    if (!rank.has(id)) rank.set(id, Math.max(-1, ...inc.get(id)!.map(depth)) + 1);
    return rank.get(id)!;
  };
  ids.forEach(depth);
  // Узел без входящих связей встаёт вплотную к тому, кого он питает, а не в начало.
  for (const id of ids) {
    const next = out.get(id)!;
    if (inc.get(id)!.length === 0 && next.length) rank.set(id, Math.min(...next.map((x) => rank.get(x)!)) - 1);
  }

  const bands = [
    ...(map.nodes.some((n) => !n.group) ? [''] : []),
    ...map.groups.filter((g) => map.nodes.some((n) => n.group === g.id)).map((g) => g.id),
  ];
  const ranks = Math.max(...rank.values()) + 1;

  // Порядок в ячейке: по среднему положению соседей, несколько проходов.
  const order = new Map<string, number>(ids.map((id, i) => [id, i]));
  const members = (band: string, r: number) =>
    map.nodes.filter((n) => (n.group ?? '') === band && rank.get(n.id) === r).map((n) => n.id);
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let r = 0; r < ranks; r++) {
      bands.forEach((band, bi) => {
        const weight = (id: string) => {
          const near = [...inc.get(id)!, ...out.get(id)!].map((x) => order.get(x)!);
          return near.length ? near.reduce((a, b) => a + b, 0) / near.length : order.get(id)!;
        };
        members(band, r).sort((a, b) => weight(a) - weight(b)).forEach((id, i) => order.set(id, bi * 100 + i));
      });
    }
  }
  return { ranks, rank, bands, cell: (band, r) => members(band, r).sort((a, b) => order.get(a)! - order.get(b)!) };
}

function place(map: MapSpec, g: Arranged, dir: Dir): Layout {
  const lr = dir === 'lr';
  const s = SIZE[dir];
  const framed = g.bands.some((b) => b !== '');
  // Подпись группы стоит сверху рамки: при раскладке слева направо это поперечная ось, иначе — главная.
  const mStart = PAD + (framed ? BAND_PAD + (lr ? 0 : BAND_HEAD) : 0);
  const mLen = g.ranks * s.m + (g.ranks - 1) * s.gm;
  const mEnd = mStart + mLen + (framed ? BAND_PAD : 0);

  const pos = new Map<string, { m: number; c: number }>();
  const bands: Band[] = [];
  let cursor = PAD;
  for (const band of g.bands) {
    const frame = band !== '';
    const cells = Array.from({ length: g.ranks }, (_, r) => g.cell(band, r));
    const tall = Math.max(...cells.map((x) => x.length));
    const inner = tall * s.c + (tall - 1) * s.gc;
    const before = frame ? BAND_PAD + (lr ? BAND_HEAD : 0) : 0;
    cells.forEach((ids, r) => {
      const used = ids.length * s.c + (ids.length - 1) * s.gc;
      ids.forEach((id, i) =>
        pos.set(id, { m: mStart + r * (s.m + s.gm), c: cursor + before + (inner - used) / 2 + i * (s.c + s.gc) }));
    });
    const extent = before + inner + (frame ? BAND_PAD : 0);
    if (frame) {
      const label = map.groups.find((x) => x.id === band)!.label;
      bands.push(lr
        ? { id: band, label, x: PAD, y: cursor, w: mEnd - PAD, h: extent }
        : { id: band, label, x: cursor, y: PAD, w: extent, h: mEnd - PAD });
    }
    cursor += extent + BAND_GAP;
  }
  const cEnd = cursor - BAND_GAP + PAD;

  const xy = (m: number, c: number) => (lr ? [m, c] : [c, m]);
  const P = (m: number, c: number) => xy(m, c).join(' ');
  // Концы стрелок расходятся вдоль стороны узла, чтобы не сливаться в одну точку.
  const port = (keys: string[], end: 0 | 1, key: string) => {
    const far = (k: string) => pos.get(k.split('>')[end])!.c;
    const sorted = [...keys].sort((a, b) => far(a) - far(b));
    return ((sorted.indexOf(key) + 1) / (sorted.length + 1)) * s.c;
  };
  const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

  const wires: Wire[] = map.edges.map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    let d: string;
    let mid: number[];
    const span = Math.round(Math.abs(b.m - a.m) / (s.m + s.gm));
    if (span > 1 && Math.abs(a.c - b.c) < s.c) {
      // Через ранг в том же ряду: дуга сбоку, иначе линия прошла бы сквозь узлы между ними.
      const m1 = a.m + s.m / 2;
      const m2 = b.m + s.m / 2;
      const c = Math.max(a.c, b.c) + s.c;
      const bend = 22 + span * 10;
      d = `M${P(m1, a.c + s.c)} C${P(m1, c + bend)} ${P(m2, c + bend)} ${P(m2, b.c + s.c)}`;
      mid = xy((m1 + m2) / 2, c + bend * 0.75);
    } else if (b.m > a.m) {
      const side = (x: { from: string; to: string }) => {
        const p = pos.get(x.from)!;
        const q = pos.get(x.to)!;
        return Math.round((q.m - p.m) / (s.m + s.gm)) > 1 && Math.abs(p.c - q.c) < s.c;
      };
      const outs = map.edges.filter((x) => x.from === e.from && pos.get(x.to)!.m > a.m && !side(x)).map(key);
      const ins = map.edges.filter((x) => x.to === e.to && pos.get(x.from)!.m < b.m && !side(x)).map(key);
      const m1 = a.m + s.m;
      const m2 = b.m;
      const c1 = a.c + port(outs, 1, key(e));
      const c2 = b.c + port(ins, 0, key(e));
      const bend = Math.max(s.gm * 0.5, (m2 - m1) * 0.45);
      d = `M${P(m1, c1)} C${P(m1 + bend, c1)} ${P(m2 - bend, c2)} ${P(m2, c2)}`;
      mid = xy((m1 + m2) / 2, (c1 + c2) / 2);
    } else if (b.m < a.m) {
      // Обратная связь: из начала узла назад, в конец цели.
      const m1 = a.m;
      const m2 = b.m + s.m;
      const c1 = a.c + s.c / 2;
      const c2 = b.c + s.c / 2;
      const bend = Math.max(s.gm * 0.5, (m1 - m2) * 0.45);
      d = `M${P(m1, c1)} C${P(m1 - bend, c1)} ${P(m2 + bend, c2)} ${P(m2, c2)}`;
      mid = xy((m1 + m2) / 2, (c1 + c2) / 2);
    } else {
      // Один ранг: прямая между обращёнными друг к другу сторонами.
      const down = b.c > a.c;
      const m = a.m + s.m / 2;
      const c1 = down ? a.c + s.c : a.c;
      const c2 = down ? b.c : b.c + s.c;
      d = `M${P(m, c1)} L${P(m, c2)}`;
      mid = xy(m, (c1 + c2) / 2);
    }
    return { from: e.from, to: e.to, label: e.label, d, lx: mid[0], ly: mid[1] };
  });

  const boxes: Box[] = map.nodes.map((n) => {
    const [x, y] = xy(pos.get(n.id)!.m, pos.get(n.id)!.c);
    return { id: n.id, x, y };
  });
  const [w, h] = xy(mEnd + PAD, cEnd);
  return { w, h, boxes, bands, wires };
}
