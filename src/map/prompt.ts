// Запрос на схему — единственное, что ΒybAi стоит в токенах: агент читает правила и пишет файл.
// Правила лежат в prompt.md. Окно кладёт их агенту навыком bybmap (src-tauri/src/hooks.rs),
// который вызывает только человек: до вызова в контекст агента не попадает ничего.
import rules from './prompt.md?raw';

export const MAP_FILE = '.bybai/map.json';

export const MAP_RULES = rules.trim();

/** Что человек набирает в терминале агента, чтобы вызвать навык. */
export const mapCommand = (agent: 'claude' | 'codex'): string => (agent === 'codex' ? '$bybmap' : '/bybmap');

/** Вызвал ли человек навык этим запросом. */
export const isMapCommand = (prompt: string): boolean => /(^|\s)[/$]bybmap(\s|$)/.test(prompt);

export const fixPrompt = (errors: string[]): string =>
  `В ${MAP_FILE} есть ошибки. Исправь только их, остальное не меняй, ответь одной строкой:\n${errors.map((e) => `- ${e}`).join('\n')}`;
