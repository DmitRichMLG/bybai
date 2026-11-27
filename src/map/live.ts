// Живая подсветка: какие узлы схемы агент трогает сейчас и что он с ними сделал за ход.
import type { Action, Session } from '../model/types';
import type { Matcher } from './spec';

/** Сколько узел остаётся подсвеченным после короткого действия, мс. */
const LINGER = 2500;

export interface NodeLive {
  active: boolean;     // действие идёт сейчас или только что закончилось
  waiting: boolean;    // агент ждёт человека на этом узле
  failed: boolean;     // последнее действие на узле упало
  edits: number;       // сколько правок и записей за ход
  reads: number;
  actions: Action[];   // действия хода на этом узле, от старых к новым
}

export interface Live {
  nodes: Map<string, NodeLive>;
  stray: number;       // действия с файлами, которые не попали ни в один узел
}

/** Узел действия: по файлам, а у команды — по её началу. */
export function nodeOf(a: Action, m: Matcher): string | undefined {
  if (a.kind === 'command') return m.command(a.target);
  if (a.kind !== 'read' && a.kind !== 'edit' && a.kind !== 'write') return undefined;
  for (const path of a.files?.map((f) => f.path) ?? [a.target]) {
    const id = m.file(path);
    if (id) return id;
  }
  return undefined;
}

export function live(s: Session | undefined, m: Matcher, now: number): Live {
  const nodes = new Map<string, NodeLive>();
  let stray = 0;
  for (const a of s?.actions ?? []) {
    if (a.turn !== s!.turn) continue;
    const id = nodeOf(a, m);
    if (!id) {
      if (a.kind === 'read' || a.kind === 'edit' || a.kind === 'write') stray++;
      continue;
    }
    const n = nodes.get(id) ?? { active: false, waiting: false, failed: false, edits: 0, reads: 0, actions: [] };
    const open = a.status === 'running' || a.status === 'waiting';
    n.active ||= open || now - (a.endedAt ?? a.startedAt) < LINGER;
    n.waiting ||= a.status === 'waiting';
    n.failed = a.status === 'failed';
    if (a.kind === 'read') n.reads++;
    if ((a.kind === 'edit' || a.kind === 'write') && a.status === 'done' && !a.stale) n.edits++;
    n.actions.push(a);
    nodes.set(id, n);
  }
  return { nodes, stray };
}
