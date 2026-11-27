import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLimits, useRoot, useSaved, useSettings, useUsage } from './data';
import { Icon } from './map/icons';
import { live } from './map/live';
import { MAP_FILE, fixPrompt, mapCommand } from './map/prompt';
import { matcher, parseMap } from './map/spec';
import { latest, project } from './model/select';
import type { Session } from './model/types';
import { merge, projectKey, sum, type ProjectStat } from './stats';
import { hookStatus, inTauri, listenerError, loadMap, pickFolder, setHooks, setOnTop, storeWrite, type Agent, type HookStatus } from './transport';
import { Canvas, type Trace } from './ui/Canvas';
import { Card } from './ui/Card';
import { PlanBar } from './ui/PlanBar';
import { Projects, type ProjectRow } from './ui/Projects';
import { SettingsMenu } from './ui/SettingsMenu';
import { Stats } from './ui/Stats';
import { StatusLine } from './ui/StatusLine';
import { TopBar, type Popover, type Tab } from './ui/TopBar';

const tabState = (sessions: Session[]): Tab['state'] =>
  sessions.some((s) => s.state === 'waiting') ? 'waiting' : sessions.some((s) => s.state === 'running') ? 'running' : sessions.length ? 'idle' : 'saved';

export function App() {
  const [error, setError] = useState('');
  const { model, events, counters } = useRoot((up) => up || setError('Нет связи со слушателем'));
  const usage = useUsage(counters);
  const limits = useLimits(counters, usage);
  const [settings, setSettings, ready] = useSettings();
  const saved = useSaved();
  const [added, setAdded] = useState<Record<string, ProjectStat>>({});   // папки, открытые вручную
  const [closed, setClosed] = useState<string[]>([]);               // вкладки, закрытые в этом запуске
  const [chosen, setChosen] = useState<string | null>(null);
  const [hooks, setHookState] = useState<HookStatus | null>(null);
  const [onTop, setTop] = useState(false);
  const [mapText, setMapText] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace>(null);
  const [stats, setStats] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!inTauri) return;
    hookStatus().then(setHookState, (e) => setError(String(e)));
    listenerError().then((e) => e && setError(e), (e) => setError(String(e)));
  }, []);

  // Сохранённое при запуске плюс то, что набежало с тех пор.
  const store = useMemo(() => merge(saved ?? { projects: {} }, counters, usage, added), [saved, counters, usage, added]);

  // Статистика пишется на диск не чаще раза в три секунды.
  const text = useMemo(() => JSON.stringify(store), [store]);
  const written = useRef('');
  useEffect(() => {
    if (!saved || text === written.current) return;
    const id = setTimeout(() => {
      written.current = text;
      storeWrite('projects', text).catch((e) => setError(String(e)));
    }, 3000);
    return () => clearTimeout(id);
  }, [text, saved]);

  const sessions = model.order.map((sid) => model.sessions[sid]);
  const of = (key: string) => sessions.filter((s) => s.state !== 'closed' && projectKey(s.cwd) === key);

  // Вкладки: открытые раньше и проекты, где сейчас идут сессии. Закрытая вкладка сама не возвращается.
  const liveKeys = sessions.filter((s) => s.state !== 'closed' && s.cwd).map((s) => projectKey(s.cwd));
  const keys = [...new Set([...settings.tabs, ...liveKeys])].filter((k) => store.projects[k] && !closed.includes(k));
  const tabs: Tab[] = keys.map((key) => {
    const mine = of(key);
    const path = store.projects[key].path;
    return { key, name: project(path), path, agents: [...new Set(mine.map((s) => s.source))], state: tabState(mine) };
  });
  // Пока настройки и статистика не прочитаны, список вкладок неполон: не затираем им сохранённый.
  useEffect(() => {
    if (ready && saved && keys.join('\n') !== settings.tabs.join('\n')) setSettings({ ...settings, tabs: keys });
  }, [ready, saved, keys.join('\n')]);

  // Без выбора человека показываем проект, где что-то происходило последним.
  const recent = [...sessions].filter((s) => s.state !== 'closed' && keys.includes(projectKey(s.cwd))).sort((a, b) => b.lastAt - a.lastAt)[0];
  const selected = chosen && keys.includes(chosen) ? chosen : recent ? projectKey(recent.cwd) : keys[0] ?? null;
  const session = selected ? latest(of(selected)) : undefined;
  const cwd = selected ? store.projects[selected].path : '';
  const totals = selected ? sum(store.projects[selected]) : undefined;

  // Часы нужны, пока агент занят и ещё пару секунд после: подсветка узла гаснет не сразу.
  const busy = sessions.some((s) => s.state === 'running' || s.state === 'waiting' || Date.now() - s.lastAt < 3000);
  const now = useNow(busy);

  // Схема лежит в папке проекта; перечитываем её раз в три секунды, пока проект выбран.
  useEffect(() => {
    setMapText(null);
    setFocus(null);
    setStats(false);
    if (!cwd) return;
    let alive = true;
    const read = () => loadMap(cwd).then((t) => alive && setMapText(t), () => undefined);
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

  const onFocus = (id: string | null) => {
    setFocus(id);
    setTrace(null);
    if (id) setStats(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPopover(null);
      setStats(false);
      onFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const copy = (value: string) =>
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }, (e) => setError(String(e)));
  const onHooks = (agent: Agent, on: boolean) =>
    setHooks(agent, on).then((st) => { setHookState(st); setError(''); }, (e) => setError(String(e)));
  const onOnTop = (on: boolean) => setOnTop(on).then(() => setTop(on), (e) => setError(String(e)));

  const open = (key: string) => {
    setClosed(closed.filter((k) => k !== key));
    if (!settings.tabs.includes(key)) setSettings({ ...settings, tabs: [...settings.tabs, key] });
    setChosen(key);
    setPopover(null);
  };
  const close = (key: string) => {
    setClosed([...closed, key]);
    if (chosen === key) setChosen(null);
  };
  const pick = () =>
    pickFolder().then((path) => {
      if (!path) return;
      setAdded({ ...added, [projectKey(path)]: { path, lastAt: Date.now(), sessions: {} } });
      open(projectKey(path));
    }, (e) => setError(String(e)));

  const rows: ProjectRow[] = Object.entries(store.projects)
    .map(([key, p]) => ({ key, name: project(p.path), path: p.path, tokens: sum(p).total, lastAt: p.lastAt, state: tabState(of(key)), open: keys.includes(key) }))
    .sort((a, b) => b.lastAt - a.lastAt);

  const copyButton = (value: string, label: string) => (
    <button class={`btn${copied ? ' is-done' : ''}`} onClick={() => copy(value)}>
      <Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Скопировано' : label}
    </button>
  );
  const command = mapCommand(session?.source ?? 'claude');
  const side = stats && selected && totals;

  return (
    <>
      {popover && <div class="veil" onClick={() => setPopover(null)} />}
      <TopBar
        tabs={tabs} selected={selected} hooks={hooks} onTop={onTop} popover={popover}
        projects={<Projects rows={rows} onOpen={open} onPick={pick} />}
        settings={<SettingsMenu settings={settings} onChange={setSettings} />}
        onSelect={setChosen} onClose={close} onPopover={setPopover} onHooks={onHooks} onOnTop={onOnTop}
      />
      <PlanBar session={session} />

      <main class={`stage${(map && focus) || side ? ' has-card' : ''}`}>
        {map ? (
          <>
            <Canvas map={map} live={lv} focus={focus} trace={trace} onFocus={onFocus} />
            {focus && !side && <Card map={map} id={focus} live={lv.nodes.get(focus)} trace={trace} onTrace={setTrace} onFocus={onFocus} />}
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
            <h2>{selected ? 'У этого проекта ещё нет схемы' : 'Ни один проект не открыт'}</h2>
            <p>
              {selected
                ? `Попросите агента составить её: наберите в его терминале ${command}. Агент запишет ${MAP_FILE}, и схема появится здесь сама.`
                : inTauri
                  ? 'Подключите Claude Code или Codex кнопкой в верхней полосе и начните сессию в терминале. Прошлые проекты открываются кнопкой «+».'
                  : 'Запустите dev/bridge.mjs и начните сессию агента с настроенными хуками.'}
            </p>
            {selected && copyButton(command, 'Скопировать команду')}
          </div>
        )}
        {side && <Stats name={project(cwd)} path={cwd} sum={totals} limits={limits} onClose={() => setStats(false)} />}
        {hooks?.codex && !sessions.some((s) => s.source === 'codex') && (
          <div class="note">Codex запускает только подтверждённые хуки: выполните в нём /hooks один раз.</div>
        )}
        {error && <div class="note is-error">{error}</div>}
      </main>

      <StatusLine
        session={session} sum={totals} stray={lv.stray} events={events} statsOpen={stats}
        onStats={() => { setStats(!stats); setFocus(null); }}
      />
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
