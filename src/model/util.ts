import type { Trimmed } from './types';

export const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isTrimmed = (v: unknown): v is Trimmed => isObj(v) && v.$trim === true;

/** Текст значения: у свёрнутой строки — её начало. */
export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isTrimmed(v)) return v.head;
  return '';
}

/** Число строк; свёрнутая строка хранит его готовым. */
export function lines(v: unknown): number {
  if (isTrimmed(v)) return v.lines;
  if (typeof v !== 'string' || v === '') return 0;
  const n = v.split('\n').length;
  return v.endsWith('\n') ? n - 1 : n;
}

/** Первая непустая строка без лишних пробелов, не длиннее max. */
export function firstLine(v: unknown, max = 160): string {
  const line = text(v).split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Путь относительно папки проекта, с прямыми слэшами. */
export function rel(path: unknown, cwd: string | undefined): string {
  const p = text(path).replace(/\\/g, '/');
  const base = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && p.toLowerCase().startsWith(base.toLowerCase() + '/')) return p.slice(base.length + 1);
  return p;
}

/** Сколько строк добавлено и убрано при замене old на next: общие строки в начале и в конце не считаются. */
export function diffLines(old: unknown, next: unknown): { added: number; removed: number } {
  if (typeof old !== 'string' || typeof next !== 'string') return { added: lines(next), removed: lines(old) };
  const a = old === '' ? [] : old.split('\n');
  const b = next === '' ? [] : next.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

export const delta = (added: number, removed: number): string =>
  [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ');

/** 1 файл, 2 файла, 5 файлов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  const word = d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  return `${n} ${word}`;
}
