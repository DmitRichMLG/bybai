import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from '../map/icons';
import { NODE_H, NODE_W, layout } from '../map/layout';
import type { Live } from '../map/live';
import { KINDS, KIND_NAME, reach, type MapSpec } from '../map/spec';

export type Trace = 'up' | 'down' | null;

interface Props {
  map: MapSpec;
  live: Live;
  focus: string | null;
  trace: Trace;
  found: Set<string> | null;     // узлы, подошедшие под поиск
  onFocus: (id: string | null) => void;
}

const clamp = (k: number) => Math.min(2, Math.max(0.25, k));
/** Preact 11 не дописывает единицы к числам в style. */
const px = (n: number) => `${n}px`;

export function Canvas({ map, live, focus, trace, found, onFocus }: Props) {
  const lay = useMemo(() => layout(map), [map]);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);

  const auto = useRef(true);   // схема вписана и человек её ещё не двигал
  const fit = () => {
    const el = box.current;
    if (!el) return;
    const k = Math.min(1, (el.clientWidth - 48) / lay.w, (el.clientHeight - 48) / lay.h);
    setView({ k, x: (el.clientWidth - lay.w * k) / 2, y: (el.clientHeight - lay.h * k) / 2 });
    auto.current = true;
  };
  useLayoutEffect(fit, [lay]);

  // Пока человек сам не двигал схему, она подстраивается под размер области.
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => auto.current && fit());
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, [lay]);

  const zoom = (factor: number, cx?: number, cy?: number) => {
    auto.current = false;
    setView((v) => {
      const el = box.current!;
      const px = cx ?? el.clientWidth / 2;
      const py = cy ?? el.clientHeight / 2;
      const k = clamp(v.k * factor);
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };

  const onWheel = (e: WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest('.mnode, .zoom')) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    box.current!.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true;
      auto.current = false;
    }
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onUp = () => {
    if (drag.current && !drag.current.moved) onFocus(null);   // щелчок по пустому месту снимает фокус
    drag.current = null;
    setDragging(false);
  };

  // Что остаётся ярким: найденное поиском, либо фокус с соседями или со всей цепочкой.
  const strong = useMemo(() => {
    if (found) return found;
    if (!focus) return null;
    const set = trace
      ? reach(map, focus, trace)
      : new Set(map.edges.flatMap((e) => (e.from === focus ? [e.to] : e.to === focus ? [e.from] : [])));
    set.add(focus);
    return set;
  }, [map, focus, trace, found]);
  const wireOn = (from: string, to: string) =>
    !!strong && !found && strong.has(from) && strong.has(to) && (trace ? true : from === focus || to === focus);

  return (
    <div
      class={`canvas${dragging ? ' is-drag' : ''}`} ref={box}
      onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
    >
      <div class="plane" style={{ width: px(lay.w), height: px(lay.h), transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {lay.bands.map((b) => (
          <div key={b.id} class="band" style={{ left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) }}><span>{b.label}</span></div>
        ))}

        <svg class="wires" width={lay.w} height={lay.h}>
          <defs>
            <marker id="tip" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto">
              <path d="M0 0.500L7.500 4 0 7.500z" />
            </marker>
          </defs>
          {lay.wires.map((w) => (
            <path
              key={`${w.from}>${w.to}`} d={w.d} marker-end="url(#tip)"
              class={wireOn(w.from, w.to) ? 'is-on' : strong ? 'is-dim' : ''}
            />
          ))}
        </svg>
        {lay.wires.map((w) => w.label && (
          <span
            key={`${w.from}>${w.to}`} style={{ left: px(w.lx), top: px(w.ly) }}
            class={`wlabel${wireOn(w.from, w.to) ? ' is-on' : strong ? ' is-dim' : ''}`}
          >{w.label}</span>
        ))}

        {lay.boxes.map((b) => {
          const n = map.nodes.find((x) => x.id === b.id)!;
          const l = live.nodes.get(n.id);
          const state = l?.waiting ? 'waiting' : l?.active ? 'live' : l?.failed ? 'failed' : '';
          const mark = l?.waiting ? '?' : l?.failed ? '✕' : l?.edits ? `+${l.edits}` : '';
          return (
            <button
              key={n.id} title={n.note ?? n.label}
              class={`mnode${state ? ` is-${state}` : ''}${n.id === focus ? ' is-focus' : ''}${strong && !strong.has(n.id) ? ' is-dim' : ''}`}
              style={{ left: px(b.x), top: px(b.y), width: px(NODE_W), height: px(NODE_H), '--k': `var(--k-${n.kind})` }}
              onClick={() => onFocus(n.id === focus ? null : n.id)}
            >
              <span class="tile"><Icon name={n.kind} size={20} /></span>
              <span class="text"><b>{n.label}</b>{n.tech && <small>{n.tech}</small>}</span>
              {mark && <span class={`mark-s${state ? ` is-${state}` : ''}`}>{mark}</span>}
            </button>
          );
        })}
      </div>

      <div class="zoom">
        <button title="Мельче" onClick={() => zoom(1 / 1.2)}><Icon name="minus" size={16} /></button>
        <span>{Math.round(view.k * 100)}%</span>
        <button title="Крупнее" onClick={() => zoom(1.2)}><Icon name="plus" size={16} /></button>
        <button title="Вписать схему в окно" onClick={fit}><Icon name="fit" size={16} /></button>
      </div>

      <div class="legend">
        {KINDS.filter((k) => map.nodes.some((n) => n.kind === k)).map((k) => (
          <span key={k}><i style={{ background: `var(--k-${k})` }} />{KIND_NAME[k]}</span>
        ))}
      </div>
    </div>
  );
}
