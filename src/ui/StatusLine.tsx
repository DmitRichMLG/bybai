import type { ComponentChildren } from 'preact';
import { Icon } from '../map/icons';
import type { Session } from '../model/types';
import { KIND, clock, current, tokens, turnActions } from '../model/select';
import { plural } from '../model/util';
import { short, type Sum } from '../stats';

interface Props {
  session?: Session;
  sum?: Sum;            // итоги выбранного проекта; нет проекта — нет счётчиков
  stray: number;
  events: number;       // сколько хуков принято с запуска окна
  statsOpen: boolean;
  onStats: () => void;
}

/** Грубая оценка: в JSON с кириллицей на токен приходится около трёх символов. */
const mapTokens = (chars: number) => Math.round(chars / 3);

/** Нижняя строка: слева то, что агент делает сейчас, справа счётчики выбранного проекта. */
export function StatusLine({ session, sum, stray, events, statsOpen, onStats }: Props) {
  const right = sum && (
    <span class="right">
      {stray > 0 && <span title="Действия с файлами, которые не относятся ни к одному узлу схемы. Если их много, схему пора обновить.">вне схемы: <b>{stray}</b></span>}
      {sum.mapChars > 0 && (
        <span class="opt" title="Оценка по этому проекту: правила схемы и записанный агентом файл. Чтение кода, которое агент делал, чтобы понять проект, сюда не входит.">
          схема ≈ <b>{short(mapTokens(sum.mapChars))}</b> токенов
        </span>
      )}
      <span class="opt" title={`Принято событий с запуска окна: ${events}. Возвращено агентам по этому проекту: ${sum.replied} байт. На хуки ΒybAi отвечает пустым ответом, поэтому в контекст модели ничего не добавляется.`}>
        хуки → агенту: <b>{plural(tokens(sum.replied), 'токен', 'токена', 'токенов')}</b>
      </span>
      <button class={`spend${statsOpen ? ' is-on' : ''}`} title="Сколько токенов агенты потратили на этот проект. Нажмите, чтобы открыть статистику." onClick={onStats}>
        <Icon name="chart" size={14} />агент: <b>{short(sum.total)}</b>
      </button>
    </span>
  );
  const line = (cls: string, act: ComponentChildren, title?: string) => (
    <div class={`log${cls}`}><span class="act" title={title}>{act}</span>{right}</div>
  );

  if (!session) return line('', sum ? 'Сессии агента в этом проекте сейчас нет' : 'Ожидание сессии');

  const now = current(session);
  if (session.state === 'waiting') return line(' is-waiting', <><Icon name="ask" size={15} /><span>Ждёт вас · {session.waitingText || now?.target}</span></>);
  if (now) return line(' is-running', <><Icon name={now.kind} size={15} /><span>{now.target}</span></>, KIND[now.kind]);
  if (session.state === 'running') return line(' is-running', 'Агент думает');

  const acts = turnActions(session);
  const last = acts[acts.length - 1];
  if (last?.status === 'failed') {
    return line(' is-failed', <><Icon name={last.kind} size={15} /><span>{last.target}{last.note ? ` · ${last.note}` : ''}</span></>);
  }
  const took = session.prompt ? ` за ${clock(session.lastAt - session.prompt.at)}` : '';
  return line('', <span>{session.state === 'closed' ? 'Сессия закрыта' : 'Ход завершён'} · {plural(acts.length, 'действие', 'действия', 'действий')}{took}</span>);
}
