import type { Action, NormEvent, Session, State, Step } from './types';
import { plural } from './util';

export const emptyState: State = { sessions: {}, order: [] };

/** Сколько действий храним на сессию: старые отбрасываются. */
const MAX_ACTIONS = 2000;
const MAX_EARLY = 20;
/** Сколько сессий держим во вкладках. */
const MAX_SESSIONS = 8;
/** Вызовы, начатые в пределах этого окна, считаются параллельными. */
const PARALLEL_MS = 1500;

export function reduce(state: State, ev: NormEvent): State {
  const prev = state.sessions[ev.sid];
  const base: Session = prev ?? {
    sid: ev.sid, source: ev.source, cwd: ev.cwd ?? '', state: 'idle', turn: 0,
    steps: [], actions: [], early: [], files: [], lastAt: ev.at,
  };
  const s = apply({ ...base, cwd: ev.cwd ?? base.cwd, lastAt: ev.at }, ev);
  const next: State = {
    sessions: { ...state.sessions, [ev.sid]: s },
    order: prev ? state.order : [...state.order, ev.sid],
  };
  return prev ? next : prune(next, ev.sid);
}

/** Когда сессий больше MAX_SESSIONS, уходит самая давняя из неактивных: сначала закрытые, потом простаивающие. */
function prune(state: State, keep: string): State {
  if (state.order.length <= MAX_SESSIONS) return state;
  const idle = state.order
    .map((sid) => state.sessions[sid])
    .filter((x) => x.sid !== keep && (x.state === 'closed' || x.state === 'idle'))
    .sort((a, b) => Number(b.state === 'closed') - Number(a.state === 'closed') || a.lastAt - b.lastAt);
  const drop = idle[0]?.sid;
  if (!drop) return state;
  const { [drop]: _gone, ...sessions } = state.sessions;
  return { sessions, order: state.order.filter((sid) => sid !== drop) };
}

function apply(s: Session, ev: NormEvent): Session {
  switch (ev.t) {
    case 'session':
      return { ...s, state: s.state === 'closed' ? 'idle' : s.state };

    case 'prompt':
      return { ...s, state: 'running', waitingText: undefined, turn: s.turn + 1, prompt: { text: ev.text, at: ev.at } };

    case 'start': {
      const step = s.steps.find((x) => x.status === 'running');
      const action: Action = {
        id: ev.id, kind: ev.kind, target: ev.target, note: ev.note, files: ev.files, thread: ev.thread,
        status: 'running', startedAt: ev.at, turn: s.turn,
        stepId: step?.id ?? null, stepText: step?.text ?? null,
      };
      // Отклонённый вызов не присылает завершения. Если тот же поток начал новое действие,
      // а старое всё ещё открыто, считаем старое оставшимся без результата. Настоящее
      // завершение, если оно всё же придёт, это исправит.
      const prior = s.actions.map((a): Action =>
        (a.status === 'running' || a.status === 'waiting') && a.kind !== 'agent'
          && a.thread === ev.thread && ev.at - a.startedAt > PARALLEL_MS
          ? { ...a, status: 'done', endedAt: ev.at, stale: a.status === 'waiting' ? 'denied' : 'lost' }
          : a,
      );
      const next: Session = { ...s, state: 'running', waitingText: undefined, actions: [...prior, action].slice(-MAX_ACTIONS) };
      // Завершение могло прийти раньше начала — применяем его сразу.
      const end = s.early.find((x) => x.id === ev.id);
      return end ? apply({ ...next, early: s.early.filter((x) => x !== end) }, { ...ev, ...end }) : next;
    }

    case 'end': {
      const a = s.actions.find((x) => x.id === ev.id && (x.status === 'running' || x.status === 'waiting' || x.stale));
      if (!a) {
        const { t, id, ok, note, error, created } = ev;
        return { ...s, early: [...s.early, { t, id, ok, note, error, created }].slice(-MAX_EARLY) };
      }
      const done: Action = {
        ...a, status: ev.ok ? 'done' : 'failed', endedAt: ev.at, stale: undefined,
        note: ev.note ?? a.note, error: ev.error,
      };
      return {
        ...s,
        state: s.state === 'closed' ? 'closed' : 'running',
        waitingText: undefined,
        actions: s.actions.map((x) => (x === a ? done : x)),
        files: ev.ok && a.files ? addFiles(s.files, a, ev.created === true) : s.files,
      };
    }

    case 'plan': {
      // Шаг опознаётся по тексту: так цепочки действий переживают пересылку плана.
      const steps: Step[] = ev.steps.map((x) => ({ id: x.text, text: x.text, status: x.status }));
      const same = steps.length === s.steps.length && steps.every((x, i) => x.id === s.steps[i].id);
      if (same) return { ...s, steps };
      // Состав плана изменился — это действие агента; смена статусов действием не считается.
      const step = s.steps.find((x) => x.status === 'running');
      const made: Action = {
        id: ev.id, kind: 'plan', target: plural(steps.length, 'шаг', 'шага', 'шагов'), status: 'done',
        startedAt: ev.at, endedAt: ev.at, turn: s.turn, stepId: step?.id ?? null, stepText: step?.text ?? null,
      };
      return { ...s, steps, planText: undefined, actions: [...s.actions, made].slice(-MAX_ACTIONS) };
    }

    case 'step': {
      const old = s.steps.find((x) => x.id === ev.id);
      if (ev.status === 'deleted') return { ...s, steps: s.steps.filter((x) => x !== old) };
      if (!old) {
        return ev.text ? { ...s, steps: [...s.steps, { id: ev.id, text: ev.text, status: ev.status ?? 'pending' }] } : s;
      }
      const next: Step = { ...old, text: ev.text ?? old.text, status: ev.status ?? old.status };
      return { ...s, steps: s.steps.map((x) => (x === old ? next : x)) };
    }

    case 'plan-text':
      return { ...s, planText: ev.text };

    case 'waiting': {
      const last = [...s.actions].reverse().find((x) => x.status === 'running');
      return {
        ...s, state: 'waiting', waitingText: ev.text,
        actions: last ? s.actions.map((x) => (x === last ? { ...x, status: 'waiting' as const } : x)) : s.actions,
      };
    }

    case 'stop':
      return { ...s, state: 'idle', waitingText: undefined, actions: settle(s.actions, ev.at) };

    case 'close':
      return { ...s, state: 'closed', waitingText: undefined, actions: settle(s.actions, ev.at) };
  }
}

/** Ход закончился: всё, что не успело завершиться, считаем прерванным. */
function settle(actions: Action[], at: number): Action[] {
  return actions.map((a) =>
    a.status === 'running' || a.status === 'waiting' ? { ...a, status: 'done', endedAt: at, note: 'прервано' } : a,
  );
}

function addFiles(files: Session['files'], a: Action, created: boolean): Session['files'] {
  let out = files;
  for (const f of a.files ?? []) {
    const old = out.find((x) => x.path === f.path);
    out = old
      ? out.map((x) => (x === old ? { ...x, added: x.added + f.added, removed: x.removed + f.removed } : x))
      : [...out, { ...f, created: f.created ?? created }];
  }
  return out;
}
