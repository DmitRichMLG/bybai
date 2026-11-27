import type { Ref } from 'preact';
import { Icon } from '../map/icons';
import type { Session } from '../model/types';
import { project } from '../model/select';
import type { Agent, HookStatus } from '../transport';

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const;

interface Props {
  sessions: Session[];
  selected?: Session;
  hooks: HookStatus | null;        // null — подключением управлять нельзя (режим разработки)
  onTop: boolean;
  query: string;
  searchRef: Ref<HTMLInputElement>;
  onQuery: (q: string) => void;
  onSelect: (sid: string) => void;
  onHooks: (agent: Agent, on: boolean) => void;
  onOnTop: (on: boolean) => void;
}

export function TopBar({ sessions, selected, hooks, onTop, query, searchRef, onQuery, onSelect, onHooks, onOnTop }: Props) {
  return (
    <div class="top">
      <div class="logo">
        <span class="mark">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
        <span>Βyb<b>Ai</b></span>
      </div>

      <div class="tabs">
        {sessions.map((s) => (
          <button
            key={s.sid} title={`${AGENT[s.source]} · ${s.cwd}`}
            class={`tab is-${s.state}${s === selected ? ' is-active' : ''}`}
            onClick={() => onSelect(s.sid)}
          >
            <i /><b>{project(s.cwd)}</b> {s.source}
          </button>
        ))}
      </div>

      <label class="search" title="Найти узел на схеме">
        <Icon name="search" size={15} />
        <input ref={searchRef} value={query} placeholder="Найти узел" onInput={(e) => onQuery((e.target as HTMLInputElement).value)} />
        <span class="key">/</span>
      </label>

      {hooks && (
        <div class="tools">
          {(['claude', 'codex'] as const).map((agent) => (
            <button
              key={agent} class={`chip${hooks[agent] ? ' is-on' : ''}`}
              title={hooks[agent]
                ? `${AGENT[agent]} подключён. Нажмите, чтобы убрать хуки ΒybAi из его настроек.`
                : `Подключить ${AGENT[agent]}: добавить хуки ΒybAi в его настройки.`}
              onClick={() => onHooks(agent, !hooks[agent])}
            >
              <i />{agent}
            </button>
          ))}
          <button class={`chip${onTop ? ' is-on' : ''}`} title="Держать окно поверх остальных" onClick={() => onOnTop(!onTop)}>
            <Icon name="pin" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
