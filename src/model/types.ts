// Общий язык приложения. Слушатель присылает Envelope, нормализаторы превращают
// его в NormEvent, reduce собирает из них состояние сессий.

export type Source = 'claude' | 'codex';

/** Сообщение слушателя: тело хука как есть и время приёма. */
export interface Envelope {
  seq: number;      // порядковый номер приёма, с 1
  at: number;       // время приёма, мс с эпохи
  source: Source;
  replied: number;  // сколько байт слушатель вернул агенту в ответ на этот хук
  body: unknown;
}

/** Строка длиннее порога приходит свёрнутой: счётчики сохранены, текст — только начало. */
export interface Trimmed {
  $trim: true;
  chars: number;
  lines: number;
  head: string;
}

export type ActionKind =
  | 'read' | 'edit' | 'write' | 'command' | 'search' | 'web' | 'agent' | 'mcp' | 'plan' | 'ask' | 'other';

export type StepStatus = 'pending' | 'running' | 'done';

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  created?: boolean;   // файл создан этим действием, если это известно заранее
}

export type Ev =
  | { t: 'session' }
  | { t: 'prompt'; text: string }
  | { t: 'start'; id: string; kind: ActionKind; target: string; note?: string; files?: FileChange[]; thread?: string }
  | { t: 'end'; id: string; ok: boolean; note?: string; error?: string; created?: boolean }
  /** План целиком: заменяет прежний (TodoWrite, update_plan). id — вызов, который его прислал. */
  | { t: 'plan'; id: string; steps: { text: string; status: StepStatus }[] }
  /** Один шаг: создать или изменить (TaskCreate, TaskUpdate). */
  | { t: 'step'; id: string; text?: string; status?: StepStatus | 'deleted' }
  /** План свободным текстом, когда списка шагов нет (режим планирования). */
  | { t: 'plan-text'; text: string }
  | { t: 'waiting'; text: string }
  | { t: 'stop' }
  | { t: 'close' };

export type StartEv = Extract<Ev, { t: 'start' }>;

export type NormEvent = Ev & {
  sid: string;       // идентификатор сессии агента
  source: Source;
  at: number;
  cwd?: string;
};

export type Normalizer = (env: Envelope) => NormEvent[];

// ── Состояние ────────────────────────────────────────────────────

export interface Step {
  id: string;
  text: string;
  status: StepStatus;
}

export type ActionStatus = 'running' | 'done' | 'failed' | 'waiting';

export interface Action {
  id: string;
  kind: ActionKind;
  target: string;
  note?: string;
  error?: string;
  status: ActionStatus;
  startedAt: number;
  endedAt?: number;
  turn: number;
  stepId: string | null;    // шаг плана, который шёл в момент начала действия
  stepText: string | null;
  files?: FileChange[];
  thread?: string;            // субагент, внутри которого шло действие
  /** Завершение так и не пришло: вызов отклонён человеком или остался без результата. */
  stale?: 'denied' | 'lost';
}

export type SessionState = 'running' | 'waiting' | 'idle' | 'closed';

export interface FileTotal extends FileChange {
  created: boolean;
}

export interface Session {
  sid: string;
  source: Source;
  cwd: string;
  state: SessionState;
  waitingText?: string;
  prompt?: { text: string; at: number };
  turn: number;
  steps: Step[];
  planText?: string;
  actions: Action[];
  /** Завершения, пришедшие раньше своего начала: хуки Codex асинхронны и могут меняться местами. */
  early: Extract<Ev, { t: 'end' }>[];
  files: FileTotal[];
  lastAt: number;
}

export interface State {
  sessions: Record<string, Session>;
  order: string[];      // по времени появления
}
