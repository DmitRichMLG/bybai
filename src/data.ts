// Данные, общие для главного окна и плашки: сессии, расход агентов, лимиты, настройки.
// Плашка считает всё сама: свёрнутое главное окно браузерный движок притормаживает.
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { root, start, type Counters, type Root } from './model/root';
import type { Source } from './model/types';
import { DEFAULTS, applySettings, parseSettings, type Settings } from './settings';
import { emptyStore, parseStore, tzMinutes, type Limits, type Store, type UsageReply } from './stats';
import { connect, emitAll, listenTo, readLimits, readUsage, storeRead, storeWrite } from './transport';

export function useRoot(onLink: (up: boolean) => void): Root {
  const [state, dispatch] = useReducer(root, start);
  useEffect(() => {
    void connect({ onEnvelope: dispatch, onLink, onReset: () => dispatch('reset') });
  }, []);
  return state;
}

/** Расход сессий. Журнал перечитывается, когда в сессии что-то произошло, и ещё раз следом: агент дописывает его с опозданием. */
export function useUsage(counters: Record<string, Counters>): Record<string, UsageReply> {
  const [usage, setUsage] = useState<Record<string, UsageReply>>({});
  const now = useRef(counters);
  now.current = counters;
  useEffect(() => {
    const seen = new Map<string, number>();   // сессия → её lastAt при прошлом чтении
    const again = new Set<string>();
    const poll = () => {
      for (const [sid, c] of Object.entries(now.current)) {
        const fresh = seen.get(sid) !== c.lastAt;
        if (!fresh && !again.delete(sid)) continue;
        if (fresh) again.add(sid);
        seen.set(sid, c.lastAt);
        readUsage(c.agent, sid, c.transcript, tzMinutes()).then((u) => u && setUsage((all) => ({ ...all, [sid]: u })), () => undefined);
      }
    };
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);
  return usage;
}

/** Лимиты подписки по агентам. Нет записи — агент работает по API или ещё ничего не сообщил. */
export function useLimits(counters: Record<string, Counters>, usage: Record<string, UsageReply>): Partial<Record<Source, Limits>> {
  const [claude, setClaude] = useState<Limits | null>(null);
  useEffect(() => {
    readLimits().then(setClaude, () => undefined);
    void listenTo<Limits | null>('limits', setClaude);
  }, []);
  // У Codex лимиты общие на учётную запись: берём из самой свежей сессии.
  const codex = Object.entries(usage)
    .filter(([sid, u]) => u.limits && counters[sid]?.agent === 'codex')
    .sort((a, b) => counters[b[0]].lastAt - counters[a[0]].lastAt)[0]?.[1].limits;
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
}

/** Настройки: читаются из файла, применяются к окну и расходятся по обоим окнам. */
export function useSettings(): [Settings, (next: Settings) => void, boolean] {
  const [settings, setSettings] = useState(DEFAULTS);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    storeRead('settings').then((text) => {
      const s = parseSettings(text);
      applySettings(s);
      setSettings(s);
      setReady(true);
    }, () => setReady(true));
    void listenTo<Settings>('settings', (s) => {
      applySettings(s);
      setSettings(s);
    });
  }, []);
  const change = (next: Settings) => {
    applySettings(next);
    setSettings(next);
    void storeWrite('settings', JSON.stringify(next, null, 2));
    void emitAll('settings', next);
  };
  return [settings, change, ready];
}

/** Статистика проектов, сохранённая к запуску окна. null — ещё читается. */
export function useSaved(): Store | null {
  const [saved, setSaved] = useState<Store | null>(null);
  useEffect(() => {
    storeRead('projects').then((text) => setSaved(parseStore(text)), () => setSaved(emptyStore));
  }, []);
  return saved;
}
