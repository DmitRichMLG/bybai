// Что показывать: шаги-дорожки из цепочки действий, счётчики, подписи.
import type { Action, ActionStatus, Session } from './types';
import { plural } from './util';

export interface Chip {
  key: string;
  kind: Action['kind'];
  target: string;
  note?: string;
  status: ActionStatus;
  startedAt: number;
}

export interface Lane {
  key: string;
  n: string;                 // номер шага в текущем плане или «·»
  title: string;
  loose: boolean;            // действия вне шагов плана
  status: 'running' | 'waiting' | 'done';
  startedAt: number;
  endedAt: number;
  chips: Chip[];
  error?: string;            // причина последней ошибки в дорожке
}

/** Дорожки текущего хода: подряд идущие действия одного шага. */
export function lanes(s: Session): Lane[] {
  const out: Lane[] = [];
  let run: Action[] = [];
  const flush = () => {
    if (run.length) out.push(lane(s, run, out.length));
    run = [];
  };
  for (const a of s.actions) {
    if (a.turn !== s.turn) continue;
    if (run.length && run[0].stepId !== a.stepId) flush();
    run.push(a);
  }
  flush();
  return out;
}

function lane(s: Session, acts: Action[], index: number): Lane {
  const first = acts[0];
  const last = acts[acts.length - 1];
  const pos = s.steps.findIndex((x) => x.id === first.stepId);
  const failed = [...acts].reverse().find((a) => a.status === 'failed' && a.error);
  const live = acts.some((a) => a.status === 'running');
  const waiting = acts.some((a) => a.status === 'waiting');
  // Шаг ещё идёт, даже если между действиями пауза.
  const stepOpen = s.state === 'running' && last === s.actions[s.actions.length - 1]
    && (first.stepId === null || s.steps[pos]?.status === 'running');
  return {
    key: `${first.turn}:${index}`,
    n: pos >= 0 ? String(pos + 1) : '·',
    title: first.stepText ?? (s.steps.length ? 'До плана' : 'Без плана'),
    loose: first.stepId === null,
    status: waiting ? 'waiting' : live || stepOpen ? 'running' : 'done',
    startedAt: first.startedAt,
    endedAt: last.endedAt ?? last.startedAt,
    chips: chips(acts),
    error: failed?.error,
  };
}

/** Подряд идущие завершённые чтения (от трёх) и новые шаги плана (от двух) сворачиваются в одно действие. */
function chips(acts: Action[]): Chip[] {
  const out: Chip[] = [];
  let group: Action[] = [];
  const flush = () => {
    const a = group[0];
    if (a && group.length >= (a.kind === 'read' ? 3 : 2)) {
      const target = a.kind === 'read'
        ? plural(group.length, 'файл', 'файла', 'файлов')
        : plural(group.length, 'шаг', 'шага', 'шагов');
      out.push({ key: a.id, kind: a.kind, target, status: 'done', startedAt: a.startedAt });
    } else {
      out.push(...group.map(chip));
    }
    group = [];
  };
  for (const a of acts) {
    const foldable = a.status === 'done' && (a.kind === 'read' || a.kind === 'plan') && !a.note && !a.stale;
    if (!foldable || (group.length && group[0].kind !== a.kind)) flush();
    if (foldable) group.push(a);
    else out.push(chip(a));
  }
  flush();
  return out;
}

const STALE = { denied: 'отклонено', lost: 'нет результата' } as const;

const chip = (a: Action): Chip => ({
  key: a.id, kind: a.kind, target: a.target, note: a.stale ? STALE[a.stale] : a.note, status: a.status, startedAt: a.startedAt,
});

export const KIND: Record<Action['kind'], string> = {
  read: 'чтение', edit: 'правка', write: 'запись', command: 'команда', search: 'поиск',
  web: 'веб', agent: 'субагент', mcp: 'mcp', plan: 'план', ask: 'вопрос', other: 'вызов',
};

/** Действие, которое идёт или ждёт прямо сейчас. */
export const current = (s: Session): Action | undefined =>
  [...s.actions].reverse().find((a) => a.status === 'running' || a.status === 'waiting');

export const turnActions = (s: Session): Action[] => s.actions.filter((a) => a.turn === s.turn);

/** 75 → «1:15», 4000 → «1:06:40». */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Имя папки проекта для вкладки. */
export const project = (cwd: string): string => cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '—';

/** Оценка токенов по числу байт, возвращённых агенту. */
export const tokens = (bytes: number): number => Math.ceil(bytes / 4);
