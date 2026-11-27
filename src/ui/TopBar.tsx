import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../map/icons';
import type { Source } from '../model/types';
import type { Agent, HookStatus } from '../transport';

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const;

/** Вкладка — проект. Точка показывает, что делают его агенты; saved — сессии сейчас нет. */
export interface Tab {
  key: string;
  name: string;
  path: string;
  agents: Source[];
  state: 'running' | 'waiting' | 'idle' | 'saved';
}

export type Popover = 'projects' | 'settings' | null;

interface Props {
  tabs: Tab[];
  selected: string | null;
  hooks: HookStatus | null;        // null — подключением управлять нельзя (режим разработки)
  onTop: boolean;
  popover: Popover;
  projects: ComponentChildren;     // список проектов под «+»
  settings: ComponentChildren;     // меню настроек
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onPopover: (p: Popover) => void;
  onHooks: (agent: Agent, on: boolean) => void;
  onOnTop: (on: boolean) => void;
}

export function TopBar({ tabs, selected, hooks, onTop, popover, projects, settings, onSelect, onClose, onPopover, onHooks, onOnTop }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  // Список проектов раскрывается вправо от «+», если там хватает места, иначе влево.
  const [toRight, setToRight] = useState(false);
  // Выбранная вкладка не должна оставаться за краем полосы.
  useEffect(() => {
    strip.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, tabs.length]);

  return (
    <div class="top">
      <div class="logo">
        <span class="mark">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
        <span>Βyb<b>Ai</b></span>
      </div>

      <div class="strip">
        {/* Колесо мыши листает вкладки вбок. */}
        <div class="tabs" ref={strip} onWheel={(e) => { strip.current!.scrollLeft += e.deltaY + e.deltaX; }}>
          {tabs.map((t) => (
            <div
              key={t.key} role="tab" tabIndex={0} title={[t.agents.map((a) => AGENT[a]).join(', '), t.path].filter(Boolean).join(' · ')}
              class={`tab is-${t.state}${t.key === selected ? ' is-active' : ''}`}
              onClick={() => onSelect(t.key)} onKeyDown={(e) => e.key === 'Enter' && onSelect(t.key)}
            >
              <i /><b>{t.name}</b>{t.agents.length > 0 && <span>{t.agents.join('+')}</span>}
              <button class="x" title="Закрыть вкладку. Проект останется в списке под «+»." onClick={(e) => { e.stopPropagation(); onClose(t.key); }}>
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
        <div class={`anchor${toRight ? ' is-left' : ''}`}>
          <button
            class={`tool${popover === 'projects' ? ' is-on' : ''}`} title="Открыть проект"
            onClick={(e) => {
              setToRight((e.currentTarget as HTMLElement).getBoundingClientRect().left + 364 <= window.innerWidth);
              onPopover(popover === 'projects' ? null : 'projects');
            }}
          >
            <Icon name="plus" size={15} />
          </button>
          {popover === 'projects' && projects}
        </div>
      </div>

      <div class="tools">
        {hooks && (['claude', 'codex'] as const).map((agent) => (
          <button
            key={agent} class={`chip${hooks[agent] ? ' is-on' : ''}`}
            title={hooks[agent]
              ? `${AGENT[agent]} подключён. Нажмите, чтобы убрать хуки и навык ΒybAi из его настроек.`
              : `Подключить ${AGENT[agent]}: добавить хуки и навык ΒybAi в его настройки.`}
            onClick={() => onHooks(agent, !hooks[agent])}
          >
            <i />{agent}
          </button>
        ))}
        {hooks && (
          <button class={`chip${onTop ? ' is-on' : ''}`} title="Держать окно поверх остальных" onClick={() => onOnTop(!onTop)}>
            <Icon name="pin" size={15} />
          </button>
        )}
        <div class="anchor">
          <button class={`tool${popover === 'settings' ? ' is-on' : ''}`} title="Настройки" onClick={() => onPopover(popover === 'settings' ? null : 'settings')}>
            <Icon name="tune" size={15} />
          </button>
          {popover === 'settings' && settings}
        </div>
      </div>
    </div>
  );
}
