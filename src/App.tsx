import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { Icon } from './map/icons';
import { live } from './map/live';
import { MAP_FILE, MAP_PROMPT, fixPrompt } from './map/prompt';
import { matcher, parseMap } from './map/spec';
import { normalizeClaude } from './model/claude';
import { normalizeCodex } from './model/codex';
import { emptyState, reduce } from './model/reduce';
import type { Envelope, Session, State } from './model/types';
import { connect, hookStatus, inTauri, listenerError, loadMap, setHooks, setOnTop, type Agent, type HookStatus } from './transport';
import { Canvas, type Trace } from './ui/Canvas';
import { Card } from './ui/Card';
import { PlanBar } from './ui/PlanBar';
import { StatusLine, type Totals } from './ui/StatusLine';
import { TopBar } from './ui/TopBar';

interface Root {
  model: State;
  totals: Totals;
}

const start: Root = { model: emptyState, totals: { events: 0, replied: 0, mapChars: 0 } };

/** Длина строки; у свёрнутой слушателем строки она хранится в поле chars. */
const size = (v: unknown): number =>
  typeof v === 'string' ? v.length : Number((v as { chars?: number } | null)?.chars ?? 0);

/** Сколько символов этот хук добавил к стоимости схемы: запрос на неё или запись её файла. */
function mapChars(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const b = body as Record<string, any>;
  if (b.hook_event_name === 'UserPromptSubmit') return String(b.prompt ?? '').includes(MAP_FILE) ? size(b.prompt) : 0;
  if (b.hook_event_name !== 'PreToolUse' || typeof b.tool_input !== 'object' || b.tool_input === null) return 0;
  const input = b.tool_input as Record<string, unknown>;
  const path = String(input.file_path ?? '').replace(/\\/g, '/');
  if (path.endsWith(MAP_FILE)) return size(input.content ?? input.new_string);
  return b.tool_name === 'apply_patch' && String(input.command ?? '').includes(MAP_FILE) ? size(input.command) : 0;
}

function root(r: Root, env: Envelope | 'reset'): Root {
  if (env === 'reset') return start;
  const events = env.source === 'codex' ? normalizeCodex(env) : normalizeClaude(env);
  return {
    model: events.reduce(reduce, r.model),
    totals: {
      events: r.totals.events + 1,
      replied: r.totals.replied + env.replied,
      mapChars: r.totals.mapChars + mapChars(env.body),
    },
  };
}

/** Без выбора человека показываем сессию, где что-то происходило последним. */
function pick(sessions: Session[], chosen: string | null): Session | undefined {
  return sessions.find((s) => s.sid === chosen)
    ?? [...sessions].sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed') || b.lastAt - a.lastAt)[0];
}

export function App() {
  const [{ model, totals }, dispatch] = useReducer(root, start);
  const [chosen, setChosen] = useState<string | null>(null);
  const [hooks, setHookState] = useState<HookStatus | null>(null);
  const [onTop, setTop] = useState(false);
  const [error, setError] = useState('');
  const [mapText, setMapText] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void connect({ onEnvelope: dispatch, onLink: (up) => up || setError('Нет связи со слушателем'), onReset: () => dispatch('reset') });
    if (!inTauri) return;
    hookStatus().then(setHookState, (e) => setError(String(e)));
    listenerError().then((e) => e && setError(e), (e) => setError(String(e)));
  }, []);

  const sessions = model.order.map((sid) => model.sessions[sid]);
  const session = pick(sessions, chosen);
  const cwd = session?.cwd ?? '';
  // Часы нужны, пока агент занят и ещё пару секунд после: подсветка узла гаснет не сразу.
  const busy = sessions.some((s) => s.state === 'running' || s.state === 'waiting' || Date.now() - s.lastAt < 3000);
  const now = useNow(busy);

  // Схема лежит в папке проекта; перечитываем её раз в три секунды, пока сессия выбрана.
  useEffect(() => {
    setMapText(null);
    setFocus(null);
    if (!cwd) return;
    let alive = true;
    const read = () => loadMap(cwd).then((text) => alive && setMapText(text), () => undefined);
    read();
    const id = setInterval(read, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cwd]);

  const parsed = useMemo(() => (mapText === null ? null : parseMap(mapText)), [mapText]);
  const map = parsed?.map;
  const match = useMemo(() => (map ? matcher(map) : null), [map]);
  const lv = match ? live(session, match, now) : { nodes: new Map(), stray: 0 };
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !map) return null;
    return new Set(map.nodes.filter((n) => `${n.label} ${n.tech ?? ''} ${n.id}`.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, map]);

  const onFocus = (id: string | null) => {
    setFocus(id);
    setTrace(null);
    setQuery('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onFocus(null);
        search.current?.blur();
      } else if (e.key === '/' && document.activeElement !== search.current) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'Enter' && document.activeElement === search.current && found?.size) {
        onFocus([...found][0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [found]);

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }, (e) => setError(String(e)));
  const onHooks = (agent: Agent, on: boolean) =>
    setHooks(agent, on).then((st) => { setHookState(st); setError(''); }, (e) => setError(String(e)));
  const onOnTop = (on: boolean) => setOnTop(on).then(() => setTop(on), (e) => setError(String(e)));

  const copyButton = (text: string, label: string) => (
    <button class={`btn${copied ? ' is-done' : ''}`} onClick={() => copy(text)}>
      <Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Скопировано' : label}
    </button>
  );

  return (
    <>
      <TopBar
        sessions={sessions} selected={session} hooks={hooks} onTop={onTop} query={query} searchRef={search}
        onQuery={setQuery} onSelect={setChosen} onHooks={onHooks} onOnTop={onOnTop}
      />
      <PlanBar session={session} />

      <main class={`stage${map && focus ? ' has-card' : ''}`}>
        {map ? (
          <>
            <Canvas map={map} live={lv} focus={focus} trace={trace} found={found} onFocus={onFocus} />
            {focus && <Card map={map} id={focus} live={lv.nodes.get(focus)} trace={trace} onTrace={setTrace} onFocus={onFocus} />}
          </>
        ) : parsed ? (
          <div class="empty">
            <span class="tile"><Icon name="files" size={26} /></span>
            <h2>В схеме есть ошибки</h2>
            <ul>{parsed.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>
            {copyButton(fixPrompt(parsed.errors), 'Скопировать запрос на исправление')}
          </div>
        ) : (
          <div class="empty">
            <span class="tile"><Icon name="service" size={26} /></span>
            <h2>{session ? 'У этого проекта ещё нет схемы' : 'Ни одна сессия не подключена'}</h2>
            <p>
              {session
                ? `Попросите агента составить её: скопируйте запрос и вставьте в его терминал. Агент запишет ${MAP_FILE}, и схема появится здесь сама.`
                : inTauri
                  ? 'Подключите Claude Code или Codex кнопкой в верхней полосе и начните сессию в терминале.'
                  : 'Запустите dev/bridge.mjs и начните сессию агента с настроенными хуками.'}
            </p>
            {session && copyButton(MAP_PROMPT, 'Скопировать запрос для агента')}
          </div>
        )}
        {hooks?.codex && !sessions.some((s) => s.source === 'codex') && (
          <div class="note">Codex запускает только подтверждённые хуки: выполните в нём /hooks один раз.</div>
        )}
        {error && <div class="note is-error">{error}</div>}
      </main>

      <StatusLine session={session} totals={totals} stray={lv.stray} />
    </>
  );
}

/** Часы для подсветки и длительностей: тикают раз в секунду и только пока есть что обновлять. */
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
