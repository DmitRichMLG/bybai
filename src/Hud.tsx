// Плашка поверх всех окон: видна, пока главное окно свёрнуто. Светофор по проектам.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLimits, useRoot, useSaved, useSettings, useUsage } from './data';
import { lamp, latest, progress, project, type Lamp } from './model/select';
import type { Session } from './model/types';
import { limitsText, merge, projectKey, short, sum } from './stats';
import { dragWindow, hideHud, inTauri, listenTo, showHud, showMain } from './transport';

/** Больше строк плашка не показывает: она не должна загораживать экран. */
const MAX_ROWS = 6;

const LAMP: Record<Lamp, string> = { idle: 'Работа не начата', run: 'Агент работает', attn: 'Нужны вы: ошибка или подтверждение', done: 'Готово' };

export function Hud() {
  const { model, counters } = useRoot(() => undefined);
  const usage = useUsage(counters);
  const limits = useLimits(counters, usage);
  const [settings] = useSettings();
  const saved = useSaved();
  // В браузере плашку смотрят как страницу: считаем, что окно свёрнуто.
  const [minimized, setMinimized] = useState(!inTauri);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('is-hud');
    void listenTo<boolean>('minimized', setMinimized);
  }, []);

  const rows = useMemo(() => {
    const store = merge(saved ?? { projects: {} }, counters, usage);
    const byProject = new Map<string, Session[]>();
    for (const sid of model.order) {
      const s = model.sessions[sid];
      if (s.state === 'closed' || !s.cwd) continue;
      const key = projectKey(s.cwd);
      byProject.set(key, [...(byProject.get(key) ?? []), s]);
    }
    return [...byProject].map(([key, sessions]) => {
      const s = latest(sessions)!;
      return { key, name: project(s.cwd), lamp: lamp(s), percent: progress(s), tokens: sum(store.projects[key]).total, lastAt: s.lastAt };
    }).sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_ROWS);
  }, [model, counters, usage, saved]);

  const plans = (['claude', 'codex'] as const).filter((a) => limits[a]);
  const visible = minimized && settings.hud.on && rows.length > 0;

  // Окно плашки подгоняется под содержимое и встаёт в выбранный угол.
  useLayoutEffect(() => {
    if (!inTauri) return;
    const el = box.current;
    if (!visible || !el) {
      void hideHud();
      return;
    }
    const place = () => void showHud(Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight), settings.hud.corner, settings.hud.mode === 'through');
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, settings.hud.corner, settings.hud.mode]);

  if (!visible) return null;
  const click = settings.hud.mode === 'click';
  return (
    <div class={`hud${click ? ' is-click' : ''}`} ref={box} onClick={click ? () => void showMain() : undefined}>
      {/* В кликабельном режиме за значок плашку перетаскивают. */}
      <span class="mark" onMouseDown={click ? (e) => { e.stopPropagation(); void dragWindow(); } : undefined} onClick={(e) => e.stopPropagation()}>
        {Array.from({ length: 9 }, (_, i) => <i key={i} />)}
      </span>
      <div class="rows">
        {rows.map((r) => (
          <div key={r.key} class={`hrow is-${r.lamp}`}>
            <i title={LAMP[r.lamp]} /><b>{r.name}</b><span class="num">{r.percent === null ? '—' : `${r.percent}%`}</span><span class="num">{short(r.tokens)}</span>
          </div>
        ))}
        {plans.length > 0 && (
          <div class="hplan" title="Расход подписки">
            {plans.map((a) => <span key={a}>{a} <b>{limitsText(limits[a]!)}</b></span>)}
          </div>
        )}
      </div>
    </div>
  );
}
