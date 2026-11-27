// Откуда приходят события: из окна Tauri или, в режиме разработки, от dev/bridge.mjs.
import type { Envelope } from './model/types';
import type { Limits, UsageReply } from './stats';

// Порт моста можно сменить: ?bridge=4599 в адресе страницы.
const BRIDGE = `http://127.0.0.1:${new URLSearchParams(location.search).get('bridge') ?? 4517}`;

export const inTauri = '__TAURI_INTERNALS__' in window;

export interface Link {
  onEnvelope: (env: Envelope) => void;
  onLink: (up: boolean) => void;
  onReset: () => void;
}

export async function connect({ onEnvelope, onLink, onReset }: Link): Promise<void> {
  let last = 0;
  const take = (env: Envelope) => {
    if (env.seq <= last) return;   // уже видели: история и живой поток пересекаются
    last = env.seq;
    onEnvelope(env);
  };

  if (inTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');
    const early: Envelope[] = [];
    let ready = false;
    await listen<Envelope>('hook', (m) => (ready ? take(m.payload) : early.push(m.payload)));
    for (const env of await invoke<Envelope[]>('backlog')) take(env);
    early.forEach(take);
    ready = true;
    onLink(true);
    return;
  }

  let boot = '';
  const es = new EventSource(`${BRIDGE}/events`);
  es.onopen = () => onLink(true);
  es.onerror = () => onLink(false);
  es.onmessage = (m) => take(JSON.parse(m.data));
  es.addEventListener('boot', (m) => {
    const id = (m as MessageEvent).data;
    if (boot && boot !== id) {
      last = 0;      // мост перезапущен: нумерация началась заново
      onReset();
    }
    boot = id;
  });
}

// ── Подключение агентов: доступно только в окне приложения ──────

export type Agent = 'claude' | 'codex';
export type HookStatus = Record<Agent, boolean>;

export async function hookStatus(): Promise<HookStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<HookStatus>('hooks_status');
}

export async function setHooks(agent: Agent, on: boolean): Promise<HookStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<HookStatus>('hooks_set', { agent, on });
}

/** Почему слушатель не запустился (например, занят порт), или null. */
export async function listenerError(): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('listener_error');
}

export async function setOnTop(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setAlwaysOnTop(on);
}

// ── Свои файлы, расход агентов, второе окно ─────────────────────
// В браузере (режим разработки) хранилище — localStorage, остального нет.

/** Какое окно открыто: главное или плашка поверх экранов. */
export const view: 'main' | 'hud' = (
  inTauri ? (window as any).__TAURI_INTERNALS__.metadata.currentWindow.label : new URLSearchParams(location.search).get('view')
) === 'hud' ? 'hud' : 'main';

export type StoreName = 'settings' | 'projects';

export async function storeRead(name: StoreName): Promise<string | null> {
  if (!inTauri) return localStorage.getItem(`bybai:${name}`);
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('store_read', { name });
}

export async function storeWrite(name: StoreName, text: string): Promise<void> {
  if (!inTauri) return localStorage.setItem(`bybai:${name}`, text);
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('store_write', { name, text });
}

/** Расход сессии из журнала агента на диске; null — журнал не найден. */
export async function readUsage(source: Agent, sid: string, transcript: string | undefined, tz: number): Promise<UsageReply | null> {
  if (!inTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UsageReply | null>('usage', { source, sid, transcript: transcript ?? null, tz });
}

/** Лимиты подписки Claude Code: последние, что прислала его строка состояния. */
export async function readLimits(): Promise<Limits | null> {
  if (!inTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Limits | null>('limits');
}

/** Событие окна: лимиты, сворачивание, смена настроек. */
export async function listenTo<T>(name: string, fn: (payload: T) => void): Promise<void> {
  if (!inTauri) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<T>(name, (m) => fn(m.payload));
}

export async function emitAll(name: string, payload: unknown): Promise<void> {
  if (!inTauri) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit(name, payload);
}

/** Диалог выбора папки проекта; null — человек передумал. */
export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return window.prompt('Папка проекта');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Папка проекта' });
  return typeof picked === 'string' ? picked : null;
}

export async function showMain(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_main');
}

/** Ставит плашку нужного размера в угол экрана и показывает её. */
export async function showHud(w: number, h: number, corner: 'tl' | 'tr' | 'bl' | 'br', through: boolean): Promise<void> {
  const { getCurrentWindow, currentMonitor, primaryMonitor, LogicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.setSize(new LogicalSize(w, h));
  const screen = (await currentMonitor()) ?? (await primaryMonitor());
  if (screen) {
    const k = screen.scaleFactor;
    const { position, size } = screen.workArea;
    const gap = 16 * k;
    const x = corner[1] === 'l' ? position.x + gap : position.x + size.width - w * k - gap;
    const y = corner[0] === 't' ? position.y + gap : position.y + size.height - h * k - gap;
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  }
  await win.setIgnoreCursorEvents(through);
  await win.show();
}

export async function hideHud(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

/** Перетаскивание плашки за её край. */
export async function dragWindow(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().startDragging();
}

/** Текст файла .bybai/map.json из папки проекта или null, если его нет. */
export async function loadMap(cwd: string): Promise<string | null> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('read_map', { cwd });
  }
  const res = await fetch(`${BRIDGE}/map?cwd=${encodeURIComponent(cwd)}`);
  return res.ok ? res.text() : null;
}
