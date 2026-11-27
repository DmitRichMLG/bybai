import { Icon } from '../map/icons';
import type { Session } from '../model/types';
import { KIND, clock, current, tokens, turnActions } from '../model/select';
import { plural } from '../model/util';

export interface Totals {
  events: number;     // сколько хуков принято
  replied: number;    // сколько байт возвращено агентам
  mapChars: number;   // сколько символов ушло на схему: запрос агенту и записанный им файл
}

/** Грубая оценка: в JSON с кириллицей на токен приходится около трёх символов. */
const mapTokens = (chars: number) => Math.round(chars / 3);
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} тыс.` : String(n));

export function StatusLine({ session, totals, stray }: { session?: Session; totals: Totals; stray: number }) {
  const right = (
    <span class="right">
      {stray > 0 && <span title="Действия с файлами, которые не относятся ни к одному узлу схемы. Если их много, схему пора обновить.">вне схемы: <b>{stray}</b></span>}
      {totals.mapChars > 0 && (
        <span title="Оценка: запрос на схему и записанный агентом файл. Чтение кода, которое агент делал, чтобы понять проект, сюда не входит.">
          схема ≈ <b>{short(mapTokens(totals.mapChars))}</b> токенов
        </span>
      )}
      <span title={`Принято событий: ${totals.events}. Возвращено агентам: ${totals.replied} байт. На хуки ΒybAi отвечает пустым ответом, поэтому в контекст модели ничего не добавляется.`}>
        хуки → агенту: <b>{plural(tokens(totals.replied), 'токен', 'токена', 'токенов')}</b>
      </span>
    </span>
  );

  if (!session) return <div class="log"><span class="act">Ожидание сессии</span>{right}</div>;

  const now = current(session);
  if (session.state === 'waiting') {
    return <div class="log is-waiting"><span class="act"><Icon name="ask" size={15} /><span>Ждёт вас · {session.waitingText || now?.target}</span></span>{right}</div>;
  }
  if (now) {
    return <div class="log is-running"><span class="act" title={KIND[now.kind]}><Icon name={now.kind} size={15} /><span>{now.target}</span></span>{right}</div>;
  }
  if (session.state === 'running') return <div class="log is-running"><span class="act">Агент думает</span>{right}</div>;

  const acts = turnActions(session);
  const last = acts[acts.length - 1];
  if (last?.status === 'failed') {
    return <div class="log is-failed"><span class="act"><Icon name={last.kind} size={15} /><span>{last.target}{last.note ? ` · ${last.note}` : ''}</span></span>{right}</div>;
  }
  const took = session.prompt ? ` за ${clock(session.lastAt - session.prompt.at)}` : '';
  return (
    <div class="log">
      <span class="act"><span>{session.state === 'closed' ? 'Сессия закрыта' : 'Ход завершён'} · {plural(acts.length, 'действие', 'действия', 'действий')}{took}</span></span>
      {right}
    </div>
  );
}
