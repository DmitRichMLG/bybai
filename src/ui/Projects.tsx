import { Icon } from '../map/icons';
import { ago, short } from '../stats';
import type { Tab } from './TopBar';

export interface ProjectRow {
  key: string;
  name: string;
  path: string;
  tokens: number;
  lastAt: number;
  state: Tab['state'];
  open: boolean;      // уже есть во вкладках
}

interface Props {
  rows: ProjectRow[];
  onOpen: (key: string) => void;
  onPick: () => void;
}

/** Все проекты, которые окно когда-либо видело, и открытие папки без сессии агента. */
export function Projects({ rows, onOpen, onPick }: Props) {
  return (
    <div class="pop projects">
      <h3>Проекты</h3>
      <div class="list">
        {rows.map((r) => (
          <button key={r.key} class={`prow is-${r.state}${r.open ? ' is-open' : ''}`} title={r.path} onClick={() => onOpen(r.key)}>
            <i /><b>{r.name}</b><em>{r.tokens ? short(r.tokens) : ''}</em>
            <small><span>{r.path}</span>· {r.state === 'running' ? 'сейчас' : r.state === 'waiting' ? 'ждёт вас' : ago(r.lastAt)}</small>
          </button>
        ))}
        {rows.length === 0 && <p class="hint">Здесь появятся проекты, в которых работали агенты.</p>}
      </div>
      <hr />
      <button class="pact" onClick={onPick}><Icon name="folder" size={16} />Открыть папку…</button>
    </div>
  );
}
