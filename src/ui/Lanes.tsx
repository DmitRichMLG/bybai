import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Session } from '../model/types';
import { KIND, clock, lanes, turnActions, type Chip, type Lane } from '../model/select';
import { plural } from '../model/util';

const time = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function Mast({ session, now }: { session: Session; now: number }) {
  const acts = turnActions(session);
  const from = session.prompt?.at ?? acts[0]?.startedAt;
  const to = session.state === 'running' || session.state === 'waiting' ? now : session.lastAt;
  return (
    <div class="mast">
      <div class="label">Задача{from ? ` · ${time(from)}` : ''}</div>
      <div class="mastmain">
        <h1 title={session.prompt?.text}>{session.prompt?.text || 'Сессия без запроса'}</h1>
        <p>{from ? `${clock(to - from)} · ` : ''}{plural(acts.length, 'действие', 'действия', 'действий')}</p>
      </div>
    </div>
  );
}

export function Lanes({ session, now }: { session: Session; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const list = lanes(session);

  // Лента следует за последним действием, пока человек не прокрутил её вверх.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = box.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div class="lanes" ref={box} onScroll={onScroll}>
      {list.length === 0 && (
        <div class="empty">
          {session.state === 'running' ? 'Агент думает.' : 'Действий пока нет.'}
          <small>Каждый вызов инструмента появится здесь сразу, как агент его начнёт.</small>
        </div>
      )}
      {list.map((l) => <LaneCard key={l.key} lane={l} now={now} />)}
    </div>
  );
}

function LaneCard({ lane, now }: { lane: Lane; now: number }) {
  const state = lane.status === 'done' ? '' : ` is-${lane.status}`;
  const took = clock((lane.status === 'done' ? lane.endedAt : now) - lane.startedAt);
  return (
    <section class={`lane${state}${lane.loose ? ' is-loose' : ''}`}>
      <header>
        <span class="n">{lane.n}</span>
        <h3 title={lane.title}>{lane.title}</h3>
        {lane.status === 'running' && <small class="running"><i /> Идёт · {took}</small>}
        {lane.status === 'waiting' && <small class="waiting">■ Ждёт вас · {took}</small>}
        {lane.status === 'done' && <small class="done">✓ {took}</small>}
      </header>
      <div class="flow">{lane.chips.map((c) => <ChipView key={c.key} chip={c} now={now} />)}</div>
      {lane.error && <div class="reason">{lane.error}</div>}
    </section>
  );
}

function ChipView({ chip, now }: { chip: Chip; now: number }) {
  const state = chip.status === 'done' ? '' : ` is-${chip.status}`;
  let note = chip.note;
  if (chip.status === 'running') note = `${Math.max(0, Math.round((now - chip.startedAt) / 1000))} с`;
  else if (chip.status === 'waiting') note = 'ждёт разрешения';
  else if (chip.status === 'failed') note = `✕ ${chip.note ?? 'ошибка'}`;
  else if (chip.kind === 'command' && !note) note = '✓';
  return (
    <span class={`act${state}`} title={chip.target}>
      <b>{KIND[chip.kind]}</b>
      <span>{chip.target}</span>
      {note && <em>{note}</em>}
    </span>
  );
}
