import type { Session } from '../model/types';
import { delta } from '../model/util';

export function PlanPanel({ session }: { session?: Session }) {
  const steps = session?.steps ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  const waiting = session?.state === 'waiting';
  return (
    <aside class="aside">
      <header class="aside-title">
        <h2>План</h2>
        <span class="chip">{steps.length ? `${done} из ${steps.length} выполнено` : 'нет плана'}</span>
      </header>

      {steps.length > 0 && (
        <>
          <div class="progress">
            {steps.map((s) => <i key={s.id} class={s.status === 'running' ? (waiting ? 'waiting' : 'running') : s.status === 'done' ? 'done' : ''} />)}
          </div>
          <section class="card">
            {steps.map((s, i) => (
              <div key={s.id} class={`row${s.status === 'done' ? ' is-done' : s.status === 'running' ? ' is-running' : ''}`}>
                <b class="n">{i + 1}</b>
                <span>{s.text}</span>
                {s.status === 'done' && <small class="done">✓</small>}
                {s.status === 'running' && <small class="running"><i /> Идёт</small>}
                {s.status === 'pending' && <small class="pending"><i /> Ожидает</small>}
              </div>
            ))}
          </section>
        </>
      )}

      {steps.length === 0 && session?.planText && (
        <section class="card">
          <header><span>План текстом</span></header>
          <pre class="plantext">{session.planText}</pre>
        </section>
      )}

      {steps.length === 0 && !session?.planText && (
        <div class="empty">
          Агент не составил план.
          <small>Ход работы виден слева.<br />План появится, когда агент заведёт список шагов.</small>
        </div>
      )}

      {session && session.files.length > 0 && (
        <section class="card files">
          <header><span>Изменённые файлы</span><b>{session.files.length}</b></header>
          {session.files.map((f) => (
            <div key={f.path} class="row">
              <span title={f.path}>{f.path}</span>
              <small class="pending">{[f.created ? 'новый' : '', delta(f.added, f.removed)].filter(Boolean).join(' · ')}</small>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}
