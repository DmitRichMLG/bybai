import { useState } from 'preact/hooks';
import type { Session } from '../model/types';
import { lanes } from '../model/select';

/** План агента одной строкой: сегменты, счёт и текущий шаг. Полный список — по клику. */
export function PlanBar({ session }: { session?: Session }) {
  const [open, setOpen] = useState(false);
  const steps = session?.steps ?? [];
  if (!session || steps.length === 0) return <div />;

  const done = steps.filter((s) => s.status === 'done').length;
  const now = steps.find((s) => s.status === 'running');
  const waiting = session.state === 'waiting';
  // Сколько действий агент сделал на каждом шаге за этот ход.
  const did = new Map<string, number>();
  for (const l of lanes(session)) did.set(l.title, (did.get(l.title) ?? 0) + l.chips.length);

  return (
    <div class="plan" onClick={() => setOpen(!open)} title="Показать шаги плана">
      <span class="bar">
        {steps.map((s) => <i key={s.id} class={s.status === 'running' ? (waiting ? 'waiting' : 'running') : s.status === 'done' ? 'done' : ''} />)}
      </span>
      <span class="count">{done}/{steps.length}</span>
      <span class="now">{now?.text ?? (done === steps.length ? 'План выполнен' : 'Следующий шаг не начат')}</span>
      {open && (
        <div class="steps">
          {steps.map((s, i) => (
            <div key={s.id} class={`step${s.status === 'done' ? ' is-done' : s.status === 'running' ? ' is-running' : ''}`}>
              <i>{s.status === 'done' ? '✓' : i + 1}</i>
              <span>{s.text}</span>
              {did.has(s.text) && <i style={{ marginLeft: 'auto', width: 'auto' }}>{did.get(s.text)}</i>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
