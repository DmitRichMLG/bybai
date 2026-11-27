// Схема проекта, которую агент пишет в .bybai/map.json. Здесь же проверка файла.

export const KINDS = ['client', 'service', 'data', 'queue', 'external', 'security', 'infra', 'files'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_NAME: Record<Kind, string> = {
  client: 'интерфейс', service: 'сервис', data: 'хранилище', queue: 'очередь',
  external: 'внешний сервис', security: 'доступ', infra: 'инфраструктура', files: 'файлы',
};

export interface MapNode {
  id: string;
  kind: Kind;
  label: string;
  tech?: string;
  note?: string;
  group?: string;
  files?: string[];   // шаблоны путей от корня проекта
  run?: string[];     // начала команд, относящихся к узлу
}

export interface MapEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MapGroup {
  id: string;
  label: string;
}

export interface MapSpec {
  title: string;
  nodes: MapNode[];
  edges: MapEdge[];
  groups: MapGroup[];
}

export const LIMITS = { nodes: 40, label: 22, tech: 22, note: 140, edgeLabel: 16, group: 24 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;

/** Разбирает текст файла. Ошибки написаны так, чтобы их можно было отдать агенту на исправление. */
export function parseMap(text: string): { map?: MapSpec; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { errors: [`Файл не является JSON: ${(e as Error).message}`] };
  }
  if (!isObj(raw)) return { errors: ['В корне должен быть объект с полями title, nodes, edges.'] };

  const errors: string[] = [];
  const long = (what: string, value: string | undefined, max: number) => {
    if (value && value.length > max) errors.push(`${what}: «${value}» длиннее ${max} символов.`);
  };

  const groups: MapGroup[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    const id = isObj(g) ? str(g.id) : undefined;
    const label = isObj(g) ? str(g.label) : undefined;
    if (!id || !label) errors.push('У каждой группы должны быть id и label.');
    else if (groups.some((x) => x.id === id)) errors.push(`Группа «${id}» объявлена дважды.`);
    else {
      long(`Группа ${id}, label`, label, LIMITS.group);
      groups.push({ id, label });
    }
  }

  const nodes: MapNode[] = [];
  const list = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (list.length === 0) errors.push('Нужен хотя бы один узел в nodes.');
  if (list.length > LIMITS.nodes) errors.push(`Узлов ${list.length}, допустимо не больше ${LIMITS.nodes}: объедини мелкие части.`);
  for (const n of list) {
    if (!isObj(n)) {
      errors.push('Каждый узел должен быть объектом.');
      continue;
    }
    const id = str(n.id);
    const label = str(n.label);
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      errors.push(`Узел «${id ?? label ?? '?'}»: id должен состоять из латинских букв, цифр и дефиса.`);
      continue;
    }
    if (nodes.some((x) => x.id === id)) {
      errors.push(`Узел «${id}» объявлен дважды.`);
      continue;
    }
    if (!label) errors.push(`Узел ${id}: нужен label.`);
    const kind = KINDS.find((k) => k === n.kind);
    if (!kind) errors.push(`Узел ${id}: kind должен быть одним из ${KINDS.join(', ')}.`);
    const group = str(n.group);
    if (group && !groups.some((g) => g.id === group)) errors.push(`Узел ${id}: группа «${group}» не объявлена в groups.`);
    const node: MapNode = {
      id, kind: kind ?? 'service', label: label ?? id, tech: str(n.tech), note: str(n.note),
      group, files: strs(n.files), run: strs(n.run),
    };
    long(`Узел ${id}, label`, node.label, LIMITS.label);
    long(`Узел ${id}, tech`, node.tech, LIMITS.tech);
    long(`Узел ${id}, note`, node.note, LIMITS.note);
    nodes.push(node);
  }

  const edges: MapEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const from = isObj(e) ? str(e.from) : undefined;
    const to = isObj(e) ? str(e.to) : undefined;
    if (!from || !to) {
      errors.push('У каждой связи должны быть from и to.');
      continue;
    }
    const missing = [from, to].find((id) => !nodes.some((n) => n.id === id));
    if (missing) {
      errors.push(`Связь ${from} → ${to}: узла «${missing}» нет.`);
      continue;
    }
    if (from === to) {
      errors.push(`Связь ${from} → ${to}: узел не может ссылаться сам на себя.`);
      continue;
    }
    if (edges.some((x) => x.from === from && x.to === to)) continue;
    const label = isObj(e) ? str(e.label) : undefined;
    long(`Связь ${from} → ${to}, label`, label, LIMITS.edgeLabel);
    edges.push({ from, to, label });
  }

  const title = str(raw.title) ?? 'Схема проекта';
  return errors.length ? { errors } : { map: { title, nodes, edges, groups }, errors };
}

// ── Сопоставление действий агента с узлами ───────────────────────

/** Шаблон пути → выражение: ** — любая глубина, * — часть имени; каталог совпадает со всем, что внутри. */
function glob(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const body = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}(/.*)?$`, 'i');
}

export interface Matcher {
  /** Узел, которому принадлежит файл: побеждает самый длинный подошедший шаблон. */
  file: (path: string) => string | undefined;
  command: (line: string) => string | undefined;
}

export function matcher(map: MapSpec): Matcher {
  const files = map.nodes
    .flatMap((n) => (n.files ?? []).map((pattern) => ({ id: n.id, size: pattern.length, re: glob(pattern) })))
    .sort((a, b) => b.size - a.size);
  const runs = map.nodes
    .flatMap((n) => (n.run ?? []).map((start) => ({ id: n.id, start: start.toLowerCase() })))
    .sort((a, b) => b.start.length - a.start.length);
  return {
    file: (path) => {
      const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
      return files.find((f) => f.re.test(p))?.id;
    },
    command: (line) => {
      const l = line.toLowerCase();
      return runs.find((r) => l.includes(r.start))?.id;
    },
  };
}

// ── Достижимость ─────────────────────────────────────────────────

/** Все узлы, из которых можно прийти в id (up) или в которые можно прийти из id (down). */
export function reach(map: MapSpec, id: string, dir: 'up' | 'down'): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const e of map.edges) {
      const next = dir === 'down' ? (e.from === cur ? e.to : undefined) : e.to === cur ? e.from : undefined;
      if (next && next !== id && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
