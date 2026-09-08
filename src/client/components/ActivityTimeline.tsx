import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivitySummary } from '../../core/activity.js';

type Day = ActivitySummary['byDate'][number];

const DAY_MS = 86_400_000;

/** Every calendar day between the first and the last, including the ones with nothing in them. */
function fillGaps(days: Day[]): Array<{ date: string; totalMs: number }> {
  if (days.length === 0) return [];
  const known = new Map(days.map((d) => [d.date, d.typingMs + d.thinkingMs] as const));
  const first = Date.parse(`${days[0].date}T00:00:00Z`);
  const last = Date.parse(`${days[days.length - 1].date}T00:00:00Z`);
  const out: Array<{ date: string; totalMs: number }> = [];
  for (let t = first; t <= last; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, totalMs: known.get(date) ?? 0 });
  }
  return out;
}

/** Ticks that land on round hours and read without crowding: at most five, never zero-only. */
function hourTicks(maxMs: number): number[] {
  const maxHours = maxMs / 3_600_000;
  if (maxHours <= 0) return [0];
  const steps = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48];
  const step = steps.find((s) => maxHours / s <= 4) ?? Math.ceil(maxHours / 4);
  const ticks: number[] = [];
  for (let h = 0; h <= maxHours + step / 2; h += step) ticks.push(h);
  return ticks;
}

const fmtHours = (h: number) => (h >= 1 ? `${Number.isInteger(h) ? h : h.toFixed(1)} h` : `${Math.round(h * 60)} min`);

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The whole span of the corpus, and the period selected out of it.
 *
 * Drawn from a series that never changes with the selection — otherwise brushing a week would
 * redraw the chart to that week and leave nothing to brush back from. Drag anywhere on the plot to
 * choose a period; the two handles adjust one edge at a time afterwards.
 */
export function ActivityTimeline({
  days,
  startDate,
  endDate,
  onSelect,
}: {
  days: Day[];
  startDate: string;
  endDate: string;
  onSelect: (range: { startDate: string; endDate: string } | null) => void;
}) {
  const series = useMemo(() => fillGaps(days), [days]);
  const maxMs = useMemo(() => Math.max(1, ...series.map((d) => d.totalMs)), [series]);
  const svgRef = useRef<SVGSVGElement>(null);
  /** While dragging: the two ends in day indices, unordered until release. */
  const [drag, setDrag] = useState<{ from: number; to: number; edge: 'new' | 'start' | 'end' } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 1000;
  const H = 180;
  const PAD_LEFT = 52;
  const PAD_BOTTOM = 22;
  const plotW = W - PAD_LEFT;
  const plotH = H - PAD_BOTTOM;
  const band = series.length > 0 ? plotW / series.length : plotW;

  const indexOf = (iso: string) => series.findIndex((d) => d.date === iso);
  const selStart = startDate ? indexOf(startDate) : -1;
  const selEnd = endDate ? indexOf(endDate) : -1;
  const hasSelection = selStart >= 0 && selEnd >= 0;

  const shown = drag
    ? { a: Math.min(drag.from, drag.to), b: Math.max(drag.from, drag.to) }
    : hasSelection
      ? { a: selStart, b: selEnd }
      : null;

  function indexFromEvent(e: { clientX: number }): number {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || series.length === 0) return 0;
    const x = ((e.clientX - rect.left) / rect.width) * W - PAD_LEFT;
    return Math.max(0, Math.min(series.length - 1, Math.floor(x / band)));
  }

  // Bound to the window rather than the SVG: a drag that leaves the chart — which is exactly what
  // happens when you select towards an edge — must keep tracking, and must still commit on release.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, to: indexFromEvent(e) } : d));
    const up = () => {
      setDrag((d) => {
        if (d) {
          const a = Math.min(d.from, d.to);
          const b = Math.max(d.from, d.to);
          onSelect({ startDate: series[a].date, endDate: series[b].date });
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, series, onSelect]);

  if (series.length === 0) return null;

  const ticks = hourTicks(maxMs);
  const tickMax = Math.max(...ticks) * 3_600_000 || maxMs;
  const y = (ms: number) => plotH - (ms / tickMax) * plotH;
  const hovered = hover !== null ? series[hover] : null;

  return (
    <div className="stack">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold text-foreground">Toute la période</h2>
        <p className="text-sm text-muted-foreground">
          {hovered
            ? `${fmtDate(hovered.date)} — ${fmtHours(hovered.totalMs / 3_600_000)}`
            : 'Glisser sur le graphique pour choisir une période.'}
        </p>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-48 w-full touch-none select-none"
        role="img"
        aria-label={`Temps par jour du ${fmtDate(series[0].date)} au ${fmtDate(series[series.length - 1].date)}`}
        onPointerDown={(e) => {
          const i = indexFromEvent(e);
          setDrag({ from: i, to: i, edge: 'new' });
        }}
        onPointerMove={(e) => setHover(indexFromEvent(e))}
        onPointerLeave={() => setHover(null)}
      >
        {/* Scale first, behind everything: without it a bar's height means nothing. */}
        {ticks.map((h) => (
          <g key={h}>
            <line x1={PAD_LEFT} x2={W} y1={y(h * 3_600_000)} y2={y(h * 3_600_000)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={PAD_LEFT - 8} y={y(h * 3_600_000) + 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 11 }}>
              {fmtHours(h)}
            </text>
          </g>
        ))}

        {shown && (
          <rect
            x={PAD_LEFT + shown.a * band}
            y={0}
            width={Math.max(band, (shown.b - shown.a + 1) * band)}
            height={plotH}
            className="fill-accent/15"
          />
        )}

        {series.map((d, i) => {
          const inSel = !shown || (i >= shown.a && i <= shown.b);
          const h = d.totalMs > 0 ? Math.max(1, plotH - y(d.totalMs)) : 0;
          if (h === 0) return null;
          return (
            <rect
              key={d.date}
              x={PAD_LEFT + i * band}
              y={plotH - h}
              width={Math.max(band * 0.9, 0.6)}
              height={h}
              className={inSel ? 'fill-accent' : 'fill-accent/25'}
            />
          );
        })}

        {shown && (
          <>
            {[shown.a, shown.b + 1].map((i, k) => (
              <g key={k}>
                <line
                  x1={PAD_LEFT + i * band}
                  x2={PAD_LEFT + i * band}
                  y1={0}
                  y2={plotH}
                  className="stroke-accent"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={PAD_LEFT + i * band - 5}
                  y={plotH / 2 - 14}
                  width={10}
                  height={28}
                  rx={3}
                  className="cursor-ew-resize fill-accent"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    // Grab the far edge as the anchor, so dragging this handle moves only this side.
                    setDrag({ from: k === 0 ? shown.b : shown.a, to: k === 0 ? shown.a : shown.b, edge: k === 0 ? 'start' : 'end' });
                  }}
                />
              </g>
            ))}
          </>
        )}

        <line x1={PAD_LEFT} x2={W} y1={plotH} y2={plotH} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{fmtDate(series[0].date)}</span>
        {hasSelection && (
          <button onClick={() => onSelect(null)} className="underline underline-offset-2 hover:text-foreground">
            Revenir à toute la période
          </button>
        )}
        <span>{fmtDate(series[series.length - 1].date)}</span>
      </div>
    </div>
  );
}
