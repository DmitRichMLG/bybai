import { useEffect, useReducer, useState } from 'preact/hooks';
import { normalizeClaude } from './model/claude';
import { normalizeCodex } from './model/codex';
import { emptyState, reduce } from './model/reduce';
import type { Envelope, Session, State } from './model/types';
import { connect, hookStatus, inTauri, listenerError, setHooks, setOnTop, type Agent, type HookStatus } from './transport';
import { Lanes, Mast } from './ui/Lanes';
import { PlanPanel } from './ui/PlanPanel';
import { StatusLine, type Totals } from './ui/StatusLine';
import { TopBar } from './ui/TopBar';

interface Root {
  model: State;
  totals: Totals;
}

const start: Root = { model: emptyState, totals: { events: 0, replied: 0 } };

function root(r: Root, env: Envelope | 'reset'): Root {
  if (env === 'reset') return start;
  const events = env.source === 'codex' ? normalizeCodex(env) : normalizeClaude(env);
  return {
    model: events.reduce(reduce, r.model),
    totals: { events: r.totals.events + 1, replied: r.totals.replied + env.replied },
  };
}

/** Без выбора человека показываем сессию, где что-то происходило последним. */
function pick(sessions: Session[], chosen: string | null): Session | undefined {
  return sessions.find((s) => s.sid === chosen)
    ?? [...sessions].sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed') || b.lastAt - a.lastAt)[0];
}

export function App() {
  const [{ model, totals }, dispatch] = useReducer(root, start);
  const [link, setLink] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [hooks, setHookState] = useState<HookStatus | null>(null);
  const [onTop, setTop] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void connect({ onEnvelope: dispatch, onLink: setLink, onReset: () => dispatch('reset') });
    if (!inTauri) return;
    hookStatus().then(setHookState, (e) => setError(String(e)));
    listenerError().then((e) => e && setError(e), (e) => setError(String(e)));
  }, []);

  const sessions = model.order.map((sid) => model.sessions[sid]);
  const session = pick(sessions, chosen);
  const live = sessions.some((s) => s.state === 'running' || s.state === 'waiting');
  const now = useNow(live);

  const onHooks = (agent: Agent, on: boolean) =>
    setHooks(agent, on).then((st) => { setHookState(st); setError(''); }, (e) => setError(String(e)));
  const onOnTop = (on: boolean) => setOnTop(on).then(() => setTop(on), (e) => setError(String(e)));

  return (
    <>
      <TopBar
        sessions={sessions} selected={session} link={link} hooks={hooks} onTop={onTop}
        onSelect={setChosen} onHooks={onHooks} onOnTop={onOnTop}
      />
      <div class="app">
        <main class="main">
          {session ? (
            <>
              <Mast session={session} now={now} />
              <Lanes session={session} now={now} />
            </>
          ) : (
            <div class="lanes">
              <div class="empty">
                Ни одна сессия не подключена.
                <small>
                  {inTauri
                    ? 'Подключите Claude Code или Codex кнопкой в верхней полосе и начните сессию в терминале.'
                    : 'Запустите dev/bridge.mjs и начните сессию агента с настроенными хуками.'}
                  <br />ΒybAi только слушает события и ничего не возвращает агенту.
                </small>
              </div>
            </div>
          )}
          {hooks?.codex && !sessions.some((s) => s.source === 'codex') && (
            <div class="hint">
              Codex запускает только подтверждённые хуки. Выполните в нём /hooks и подтвердите хуки ΒybAi; это нужно сделать один раз.
            </div>
          )}
          {error && <div class="reason">{error}</div>}
        </main>
        <PlanPanel session={session} />
      </div>
      <StatusLine session={session} totals={totals} />
    </>
  );
}

/** Часы для длительностей: тикают раз в секунду и только пока агент занят. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
