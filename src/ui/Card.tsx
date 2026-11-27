import { Icon } from '../map/icons';
import type { NodeLive } from '../map/live';
import { KIND_NAME, reach, type MapSpec } from '../map/spec';
import type { Action } from '../model/types';
import type { Trace } from './Canvas';

interface Props {
  map: MapSpec;
  id: string;
  live?: NodeLive;
  trace: Trace;
  onTrace: (t: Trace) => void;
  onFocus: (id: string | null) => void;
}

const base = (path: string) => path.split('/').pop() || path;

/** Карточка узла: всё, чего нет на холсте. */
export function Card({ map, id, live, trace, onTrace, onFocus }: Props) {
  const node = map.nodes.find((n) => n.id === id);
  if (!node) return null;
  const name = (x: string) => map.nodes.find((n) => n.id === x)!;
  const ins = map.edges.filter((e) => e.to === id);
  const outs = map.edges.filter((e) => e.from === id);
  const up = reach(map, id, 'up').size;
  const down = reach(map, id, 'down').size;
  const did = (live?.actions ?? []).slice(-8).reverse();

  return (
    <aside class="card" style={{ '--k': `var(--k-${node.kind})` }}>
      <header>
        <span class="tile"><Icon name={node.kind} size={20} /></span>
        <div>
          <h2>{node.label}</h2>
          <small>{KIND_NAME[node.kind]}{node.tech ? ` · ${node.tech}` : ''}</small>
        </div>
        <button class="x" title="Закрыть" onClick={() => onFocus(null)}><Icon name="close" size={16} /></button>
      </header>

      <div class="body">
        {node.note && <p>{node.note}</p>}

        <div class="reach">
          <button class={trace === 'up' ? 'is-on' : ''} disabled={!up} onClick={() => onTrace(trace === 'up' ? null : 'up')}>
            <Icon name="up" size={16} /> Откуда · {up}
          </button>
          <button class={trace === 'down' ? 'is-on' : ''} disabled={!down} onClick={() => onTrace(trace === 'down' ? null : 'down')}>
            Куда · {down} <Icon name="down" size={16} />
          </button>
        </div>

        {did.length > 0 && (
          <dl>
            <dt>Агент за этот ход</dt>
            <dd>{did.map((a) => <Did key={a.id} a={a} />)}</dd>
          </dl>
        )}

        {ins.length + outs.length > 0 && (
          <dl>
            <dt>Связи</dt>
            <dd>
              {ins.map((e) => <Rel key={`i${e.from}`} map={name(e.from)} dir="up" label={e.label} onFocus={onFocus} />)}
              {outs.map((e) => <Rel key={`o${e.to}`} map={name(e.to)} dir="down" label={e.label} onFocus={onFocus} />)}
            </dd>
          </dl>
        )}

        {node.files && node.files.length > 0 && (
          <dl>
            <dt>Файлы</dt>
            <dd>{node.files.map((f) => <span key={f} class="path">{f}</span>)}</dd>
          </dl>
        )}
      </div>
    </aside>
  );
}

function Rel({ map: n, dir, label, onFocus }: { map: MapSpec['nodes'][number]; dir: 'up' | 'down'; label?: string; onFocus: (id: string) => void }) {
  return (
    <button class="rel" style={{ '--k': `var(--k-${n.kind})` }} onClick={() => onFocus(n.id)}>
      <Icon name={dir} size={14} /><Icon name={n.kind} size={16} />{n.label}{label && <em>{label}</em>}
    </button>
  );
}

function Did({ a }: { a: Action }) {
  const state = a.status === 'done' ? '' : ` is-${a.status}`;
  const note = a.status === 'running' ? 'идёт' : a.status === 'waiting' ? 'ждёт вас' : a.status === 'failed' ? (a.note ?? 'ошибка') : a.note;
  return (
    <div class={`did${state}`} title={a.target}>
      <Icon name={a.kind} size={15} /><span>{a.kind === 'command' ? a.target : base(a.target)}</span>{note && <em>{note}</em>}
    </div>
  );
}
