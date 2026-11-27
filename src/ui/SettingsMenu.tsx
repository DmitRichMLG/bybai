import { COLORS, CORNERS, THEMES, type Settings } from '../settings';

const CORNER_NAME = { tl: 'Слева сверху', tr: 'Справа сверху', bl: 'Слева снизу', br: 'Справа снизу' } as const;

/** Цвет токена, как он действует сейчас: тема или своё значение поверх неё. */
const effective = (key: string): string => getComputedStyle(document.documentElement).getPropertyValue(`--${key}`).trim();

export function SettingsMenu({ settings: s, onChange }: { settings: Settings; onChange: (next: Settings) => void }) {
  const hud = (patch: Partial<Settings['hud']>) => onChange({ ...s, hud: { ...s.hud, ...patch } });
  return (
    <div class="pop set">
      <h3>Тема</h3>
      <div class="themes">
        {THEMES.map((t) => (
          // Миниатюра берёт цвета из темы через data-theme, без копий в коде.
          <button key={t.id} data-theme={t.id} class={`theme${s.theme === t.id ? ' is-on' : ''}`} onClick={() => onChange({ ...s, theme: t.id })}>
            <span class="pre" /><span>{t.name}</span>
          </button>
        ))}
      </div>
      <hr />
      <h3>Свои цвета</h3>
      {COLORS.map(({ key, name }) => {
        const value = s.colors[key] ?? effective(key);
        return (
          <label key={key} class="crow">
            {name}<code>{value}</code>
            <input type="color" class="well" value={value} onInput={(e) => onChange({ ...s, colors: { ...s.colors, [key]: (e.target as HTMLInputElement).value } })} />
          </label>
        );
      })}
      <button class="link" disabled={Object.keys(s.colors).length === 0} onClick={() => onChange({ ...s, colors: {} })}>Сбросить к теме</button>
      <hr />
      <h3>Плашка при сворачивании</h3>
      <label class="crow">Показывать
        <button class={`sw${s.hud.on ? ' is-on' : ''}`} role="switch" aria-checked={s.hud.on} onClick={() => hud({ on: !s.hud.on })} />
      </label>
      <div class="seg">
        <button class={s.hud.mode === 'through' ? 'is-on' : ''} title="Клики проходят сквозь плашку в окно под ней" onClick={() => hud({ mode: 'through' })}>Сквозь клики</button>
        <button class={s.hud.mode === 'click' ? 'is-on' : ''} title="Щелчок разворачивает окно, за значок плашку можно перетащить" onClick={() => hud({ mode: 'click' })}>Кликабельная</button>
      </div>
      <div class="crow">Угол экрана
        <span class="corner">
          {CORNERS.map((c) => <button key={c} class={s.hud.corner === c ? 'is-on' : ''} title={CORNER_NAME[c]} onClick={() => hud({ corner: c })} />)}
        </span>
      </div>
    </div>
  );
}
