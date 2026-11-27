// Откуда приходят события: из окна Tauri или, в режиме разработки, от dev/bridge.mjs.
import type { Envelope } from './model/types';

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

/** Текст файла .bybai/map.json из папки проекта или null, если его нет. */
export async function loadMap(cwd: string): Promise<string | null> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('read_map', { cwd });
  }
  const res = await fetch(`${BRIDGE}/map?cwd=${encodeURIComponent(cwd)}`);
  return res.ok ? res.text() : null;
}
