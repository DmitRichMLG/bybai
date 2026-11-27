// Настройки окна: тема, свои цвета, плашка при сворачивании, открытые вкладки.
// Хранятся в ~/.bybai/settings.json. Цвета тем заданы в design/tokens.css.

export const THEMES = [
  { id: 'lime', name: 'Лайм' },
  { id: 'ice', name: 'Лёд' },
  { id: 'lilac', name: 'Сирень' },
  { id: 'graphite', name: 'Графит' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

/** Цвета, которые человек может задать поверх темы: имя токена → подпись. */
export const COLORS = [
  { key: 'bg', name: 'Холст' },
  { key: 'live', name: 'Работает' },
  { key: 'fail', name: 'Ошибка' },
  { key: 'attn', name: 'Ждёт вас' },
] as const;
export type ColorKey = (typeof COLORS)[number]['key'];

export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];

export interface Settings {
  theme: ThemeId;
  colors: Partial<Record<ColorKey, string>>;
  hud: {
    on: boolean;                 // показывать плашку, когда окно свёрнуто
    mode: 'through' | 'click';   // клики проходят сквозь плашку или она сама их принимает
    corner: Corner;
  };
  tabs: string[];                // открытые вкладки проектов
}

export const DEFAULTS: Settings = { theme: 'lime', colors: {}, hud: { on: true, mode: 'through', corner: 'tl' }, tabs: [] };

const HEX = /^#[0-9a-f]{6}$/i;

/** Разбирает сохранённый файл; всё незнакомое заменяется значением по умолчанию. */
export function parseSettings(text: string | null): Settings {
  let raw: any = null;
  try {
    raw = JSON.parse(text ?? '');
  } catch {
    // файла нет или он испорчен: настройки по умолчанию
  }
  const colors: Settings['colors'] = {};
  for (const { key } of COLORS) if (HEX.test(raw?.colors?.[key] ?? '')) colors[key] = raw.colors[key];
  return {
    theme: THEMES.find((t) => t.id === raw?.theme)?.id ?? DEFAULTS.theme,
    colors,
    hud: {
      on: typeof raw?.hud?.on === 'boolean' ? raw.hud.on : DEFAULTS.hud.on,
      mode: raw?.hud?.mode === 'click' ? 'click' : 'through',
      corner: CORNERS.find((c) => c === raw?.hud?.corner) ?? DEFAULTS.hud.corner,
    },
    tabs: Array.isArray(raw?.tabs) ? raw.tabs.filter((x: unknown): x is string => typeof x === 'string').slice(0, 30) : [],
  };
}

/** Тема — атрибут на корне, свои цвета — токены поверх неё. */
export function applySettings(s: Settings, el: HTMLElement = document.documentElement): void {
  el.dataset.theme = s.theme;
  for (const { key } of COLORS) {
    if (s.colors[key]) el.style.setProperty(`--${key}`, s.colors[key]!);
    else el.style.removeProperty(`--${key}`);
  }
}
