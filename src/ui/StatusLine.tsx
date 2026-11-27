import type { Session } from '../model/types';
import { KIND, clock, current, tokens, turnActions } from '../model/select';
import { plural } from '../model/util';

export interface Totals {
  events: number;     // сколько хуков принято
  replied: number;    // сколько байт возвращено агентам
}

export function StatusLine({ session, totals }: { session?: Session; totals: Totals }) {
  const cost = (
    <span
      class="right"
      title={`Принято событий: ${totals.events}. Возвращено агентам: ${totals.replied} байт. ΒybAi отвечает на хуки пустым ответом, поэтому в контекст модели ничего не добавляется.`}
    >
      ΒybAi → агенту: <b>{plural(tokens(totals.replied), 'токен', 'токена', 'токенов')}</b>
    </span>
  );

  if (!session) return <div class="log is-idle"><b>○</b><span>Ожидание сессии</span>{cost}</div>;

  const now = current(session);
  if (session.state === 'waiting') {
    return <div class="log is-waiting"><b>■ ждёт вас</b><span>{session.waitingText || now?.target}</span>{cost}</div>;
  }
  if (now) return <div class="log"><b>▸ {KIND[now.kind]}</b><span>{now.target}</span>{cost}</div>;
  if (session.state === 'running') return <div class="log"><b>▸</b><span>Агент думает</span>{cost}</div>;

  const acts = turnActions(session);
  const last = acts[acts.length - 1];
  const took = session.prompt ? ` за ${clock(session.lastAt - session.prompt.at)}` : '';
  const done = session.state === 'closed' ? 'Сессия закрыта' : 'Ход завершён';
  if (last?.status === 'failed') {
    return <div class="log is-failed"><b>✕ {KIND[last.kind]}</b><span>{last.target}{last.note ? ` · ${last.note}` : ''}</span>{cost}</div>;
  }
  return (
    <div class="log is-idle">
      <b>○</b><span>{done} · {plural(acts.length, 'действие', 'действия', 'действий')}{took}</span>{cost}
    </div>
  );
}
