import { Icon } from '../map/icons';
import type { Source } from '../model/types';
import { dayOf, limitsText, short, span, type Limits, type Sum } from '../stats';

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const;
/** Столбцов в графике по дням. */
const DAYS = 7;

interface Props {
  name: string;
  path: string;
  sum: Sum;
  limits: Partial<Record<Source, Limits>>;
  onClose: () => void;
}

const dayLabel = (day: number) => new Date(day * 86400000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Статистика проекта: занимает место карточки узла. */
export function Stats({ name, path, sum, limits, onClose }: Props) {
  const { usage } = sum;
  const today = dayOf(Date.now());
  const days = Array.from({ length: DAYS }, (_, i) => sum.days[today - DAYS + 1 + i] ?? 0);
  const peak = Math.max(1, ...days);
  const agents = (['claude', 'codex'] as const).filter((a) => sum.byAgent[a] > 0);
  const plans = (['claude', 'codex'] as const).filter((a) => limits[a]);

  return (
    <aside class="card">
      <header>
        <span class="tile is-plain"><Icon name="chart" size={20} /></span>
        <div><h2>{name}</h2><small>{path}</small></div>
        <button class="x" title="Закрыть" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>

      <div class="body">
        <dl>
          <dt>Токены агента</dt>
          <dd>
            <div class="big">{sum.total.toLocaleString('ru-RU')}<small>за всё время</small></div>
            {sum.total > 0 && (
              <div class="stack">
                <i class="in" style={{ flex: usage.input }} /><i class="cache" style={{ flex: usage.cache }} /><i class="out" style={{ flex: usage.output }} />
              </div>
            )}
            <div class="kv"><i class="in" />Вход<em>{short(usage.input)}</em></div>
            <div class="kv"><i class="cache" />Кэш<em>{short(usage.cache)}</em></div>
            <div class="kv"><i class="out" />Выход<em>{short(usage.output)}</em></div>
          </dd>
        </dl>

        {agents.length > 0 && (
          <dl>
            <dt>По агентам</dt>
            <dd>{agents.map((a) => <div key={a} class="kv is-plain">{AGENT[a]}<em>{short(sum.byAgent[a])}</em></div>)}</dd>
          </dl>
        )}

        {plans.length > 0 && (
          <dl title="Расход подписки общий на учётную запись, а не на проект.">
            <dt>Подписка</dt>
            <dd>{plans.map((a) => <div key={a} class="kv is-plain">{AGENT[a]}<em>{limitsText(limits[a]!)}</em></div>)}</dd>
          </dl>
        )}

        <dl title="Что сам ΒybAi добавил агенту: правила схемы и записанный файл. На хуки окно отвечает пустым ответом.">
          <dt>Расход ΒybAi</dt>
          <dd>
            <div class="kv is-plain">Схема<em>{sum.mapChars ? `≈ ${short(Math.round(sum.mapChars / 3))}` : '0'}</em></div>
            <div class="kv is-plain">Ответы на хуки<em>{Math.ceil(sum.replied / 4)}</em></div>
          </dd>
        </dl>

        <dl>
          <dt>Работа</dt>
          <dd>
            <div class="kv is-plain">Сессий<em>{sum.sessions}</em></div>
            <div class="kv is-plain">Действий<em>{sum.actions}</em></div>
            <div class={`kv is-plain${sum.errors ? ' is-fail' : ''}`}>Ошибок<em>{sum.errors}</em></div>
            <div class="kv is-plain">Время агента<em>{span(sum.workMs)}</em></div>
          </dd>
        </dl>

        <dl>
          <dt>По дням</dt>
          <dd>
            <div class="days">
              {days.map((n, i) => <i key={i} class={i === DAYS - 1 ? 'is-today' : ''} title={`${dayLabel(today - DAYS + 1 + i)}: ${short(n)}`} style={{ height: `${Math.round((n / peak) * 100)}%` }} />)}
            </div>
            <div class="days-l"><span>{dayLabel(today - DAYS + 1)}</span><span>сегодня</span></div>
          </dd>
        </dl>
      </div>
    </aside>
  );
}
