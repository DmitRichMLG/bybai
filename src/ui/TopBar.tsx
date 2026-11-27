import type { Session } from '../model/types';
import { project } from '../model/select';
import type { Agent, HookStatus } from '../transport';

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const;
const STATE = { running: 'работает', waiting: 'ждёт вас', idle: 'ход завершён', closed: 'сессия закрыта' } as const;

interface Props {
  sessions: Session[];
  selected?: Session;
  link: boolean;
  hooks: HookStatus | null;        // null — подключением управлять нельзя (режим разработки)
  onTop: boolean;
  onSelect: (sid: string) => void;
  onHooks: (agent: Agent, on: boolean) => void;
  onOnTop: (on: boolean) => void;
}

export function TopBar({ sessions, selected, link, hooks, onTop, onSelect, onHooks, onOnTop }: Props) {
  return (
    <div class="top">
      <div class="logo">
        <span class="mark">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
        <span>Βyb<b>Ai</b></span>
      </div>

      <div class="tabs">
        {sessions.map((s) => (
          <button
            key={s.sid}
            class={`tab is-${s.state}${s === selected ? ' is-active' : ''}`}
            onClick={() => onSelect(s.sid)}
          >
            <i /><b>{s.source}</b> {project(s.cwd)}
          </button>
        ))}
      </div>

      <div class="tools">
        {hooks && (['claude', 'codex'] as const).map((agent) => (
          <button
            key={agent}
            class={`plug${hooks[agent] ? ' is-on' : ''}`}
            title={hooks[agent] ? `Отключить ${AGENT[agent]}: убрать хуки ΒybAi из его настроек` : `Подключить ${AGENT[agent]}: добавить хуки ΒybAi в его настройки`}
            onClick={() => onHooks(agent, !hooks[agent])}
          >
            {agent}: {hooks[agent] ? 'подключён' : 'подключить'}
          </button>
        ))}
        {hooks && (
          <button class={`plug${onTop ? ' is-on' : ''}`} title="Держать окно поверх остальных" onClick={() => onOnTop(!onTop)}>
            поверх окон
          </button>
        )}
      </div>

      {!link ? (
        <div class="status is-lost"><i /> Нет связи со слушателем</div>
      ) : selected ? (
        <div class={`status is-${selected.state}`}><i /> {AGENT[selected.source]} · {STATE[selected.state]}</div>
      ) : (
        <div class="status is-lost"><i /> Нет сессий</div>
      )}
    </div>
  );
}
