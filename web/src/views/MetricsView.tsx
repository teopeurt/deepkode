// Responsibility: metrics view (M4 §5.2) —— sequential task curves + metrics panel.
// Sequence curves: x = execution order (created_at ascending), y = metric; colored by group_tag (A/B control experiment).
// Panel: task count / total cost / average cost / average turns / acceptance pass rate / average cache hit rate.
// Zero dependencies: hand-drawn SVG polylines (points + native title tooltips).
import { useEffect, useMemo, useRef, useState } from 'react';
import { getMetrics, type MetricRow } from '../api/client';
import { InsightCards, type InsightPage } from '../components/InsightCards';
import { LoadingState } from '../components/LoadingState';
import { useProjection, relTime } from '../store/projection';
import { RecordsTable } from '../components/RecordsTable';
import { useUi, writeHash } from '../store/ui';

const W0 = 680, H = 150, P = { l: 46, r: 14, t: 16, b: 22 };

function nice(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Line chart: values = numbers in x order; fixedMax = fixed y ceiling (e.g. 1 for hit rate) */
function Line({
  series, fixedMax, fmt, label,
}: {
  series: { name: string; color: string; pts: Array<{ x: number; y: number | null }> }[];
  fixedMax?: number;
  fmt: (v: number) => string;
  label: string;
}) {
  // Width adapts to the container (lines fill the width, no blank space on the right)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(W0)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setW(Math.max(320, el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const all = series.flatMap((s) => s.pts.map((p) => p.y).filter((y): y is number => y != null));
  const max = fixedMax ?? nice(Math.max(...all, 1));
  const xOf = (i: number, n: number) => (n <= 1 ? P.l + iw / 2 : P.l + (i / (n - 1)) * iw);
  const yOf = (v: number) => P.t + ih - (v / max) * ih;
  // Grid (4 horizontal lines)
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: P.t + ih * f, v: max * (1 - f) }));
  return (
    <div className="m-line" ref={wrapRef}>
      <div className="m-line-label">{label}</div>
      <svg width={W} height={H} className="m-svg" style={{ display: "block", width: "100%" }}>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={g.y} y2={g.y} className="m-grid" />
            <text x={P.l - 6} y={g.y + 3} className="m-axis">{fmt(g.v)}</text>
          </g>
        ))}
        {series.map((s) => {
          const d = s.pts.map((p, i) => {
            if (p.y == null) return '';
            return `${i === 0 ? 'M' : 'L'}${xOf(p.x, s.pts.length).toFixed(1)},${yOf(p.y).toFixed(1)}`;
          }).filter(Boolean).join(' ');
          return (
            <g key={s.name}>
              {d ? <path d={d} fill="none" className="m-path" style={{ stroke: s.color }} /> : null}
              {s.pts.map((p, i) =>
                p.y == null ? null : (
                  <circle key={i} cx={xOf(p.x, s.pts.length)} cy={yOf(p.y)} r={2.6} fill={s.color} className="m-dot">
                    <title>{`${s.name} · #${p.x + 1}: ${fmt(p.y!)}`}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
      </svg>
      <div className="m-legend">
        {series.map((s) => (
          <span key={s.name} className="m-legend-item"><span className="m-sw" style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}

export function MetricsView({ pid }: { pid: string }) {
  const [rows, setRows] = useState<MetricRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const cards = useProjection((s) => s.cards[pid] || {});
  const chats = useProjection((s) => s.chats[pid] || {});

  useEffect(() => {
    let alive = true;
    getMetrics(pid).then((rs) => { if (alive) setRows(rs); }).catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [pid]);

  const m = useMemo(() => {
    if (!rows) return null;
    const seq = [...rows].sort((a, b) => a.created_at - b.created_at); // chronological order
    // Group normalization: an experiment's group_tag looks like 'A:<experiment name>'/'B:<experiment name>' (the name differs each run) ——
    // splitting the chart by tag would overlap 12 groups of lines, so merge into three groups: all / group A / group B (sequence-curve semantics)
    const groupOf = (r: MetricRow): string => {
      const g = r.group_tag || ''
      if (g.startsWith('A')) return 'Group A'
      if (g.startsWith('B')) return 'Group B'
      return 'All'
    }
    const groups = new Map<string, MetricRow[]>();
    seq.forEach((r) => {
      const g = groupOf(r)
      groups.set(g, [...(groups.get(g) || []), r]);
    });
    // x axis = global execution order (all groups share one timeline, so lines align by real execution order; per-group indices would misalign and overlap groups)
    // metrics rows have no stable id (the table has no id column) —— use the object reference as the Map key (groups partitions the very same objects in seq)
    const timeIndex = new Map<MetricRow, number>()
    seq.forEach((r, i) => timeIndex.set(r, i))
    const series = (pick: (r: MetricRow) => number | null) =>
      [...groups.entries()].map(([name, rs], gi) => ({
        name,
        color: gi === 0 ? 'var(--blue)' : gi === 1 ? 'var(--green)' : 'var(--yellow)',
        pts: rs.map((r) => ({ x: timeIndex.get(r) ?? 0, y: pick(r) })),
      }));
    // Cumulative cost (accumulated within each group; x still uses the global order for alignment)
    const cum = (rs: MetricRow[]) => { let acc = 0; return rs.map((r) => { acc += r.cost; return acc; }); };
    const cumSeries = [...groups.entries()].map(([name, rs], gi) => ({
      name,
      color: gi === 0 ? 'var(--blue)' : gi === 1 ? 'var(--green)' : 'var(--yellow)',
      pts: cum(rs).map((v, i) => ({ x: timeIndex.get(rs[i]) ?? 0, y: v })),
    }));
    const verified = seq.filter((r) => r.verified === true).length;
    const verifiedTotal = seq.filter((r) => r.verified === true || r.verified === false).length;
    return {
      seq,
      total: seq.length,
      totalCost: seq.reduce((a, r) => a + r.cost, 0),
      avgCost: seq.length ? seq.reduce((a, r) => a + r.cost, 0) / seq.length : 0,
      avgTurns: seq.length ? seq.reduce((a, r) => a + r.turns, 0) / seq.length : 0,
      verifiedRate: verifiedTotal ? verified / verifiedTotal : null,
      verifiedTotal,
      avgCache: seq.filter((r) => r.cache_hit > 0).length
        ? seq.filter((r) => r.cache_hit > 0).reduce((a, r) => a + r.cache_hit, 0) / seq.filter((r) => r.cache_hit > 0).length
        : null,
      costSeries: series((r) => r.cost),
      cumSeries,
      turnsSeries: series((r) => r.turns),
      cacheSeries: series((r) => (r.cache_hit > 0 ? r.cache_hit : null)),
    };
  }, [rows]);

  if (err) return <div id="metrics" className="m-empty">Failed to load metrics: {err}</div>;
  if (!m) return <div id="metrics" className="m-empty"><LoadingState variant="pixel" label="Loading metrics…" /></div>;
  if (m.total === 0) return <div id="metrics" className="m-empty">No execution metrics yet —— after a few tasks run, this shows how cost / turns / hit rate evolve as knowledge accumulates.</div>;

  const yuan = (v: number) => `¥${v >= 0.01 ? v.toFixed(3) : v.toFixed(4)}`;
  const num = (v: number) => String(Math.round(v * 100) / 100);
  const titleOf = (sid: string) => {
    for (const c of Object.values(cards)) {
      if (c.executions[sid]) return c.title || sid.slice(0, 8);
    }
    if (chats[sid]) return chats[sid].title || 'Simple chat';
    return sid.slice(0, 8);
  };
  const goSessions = () => {
    useUi.getState().setRoute({ view: 'sessions', openId: null, tab: 'comments', sessionId: null });
    writeHash(pid, 'sessions', null, 'comments');
  };
  const worst = m.seq.reduce((a, r) => (r.cost > a.cost ? r : a));
  const best = m.seq.reduce((a, r) => (r.cost < a.cost ? r : a));
  const vsAvg = m.avgCost > 0 ? (worst.cost - m.avgCost) / m.avgCost : 0;
  const cachePts = m.seq.map((r) => r.cache_hit).filter((v) => v > 0);
  const costPts = m.seq.map((r) => r.cost);
  const insights: InsightPage[] = [
    {
      id: 'cost',
      body: (
        <>
          This project's <code>{m.total}</code> executions cost <code>{yuan(m.totalCost)}</code> in total.
          The most expensive was {titleOf(worst.task_id)} — <code>{yuan(worst.cost)}</code>
          {vsAvg > 0 ? <>, <code>{Math.round(vsAvg * 100)}%</code> above average</> : null}.
        </>
      ),
      sparks: [
        { label: titleOf(worst.task_id), value: yuan(worst.cost), delta: vsAvg },
        { label: titleOf(best.task_id), value: yuan(best.cost), delta: m.avgCost > 0 ? (best.cost - m.avgCost) / m.avgCost : 0 },
        { label: 'Average', value: yuan(m.avgCost) },
      ],
      series: costPts,
      seriesLabel: 'Cost per run',
      fmt: yuan,
      cta: { label: 'Look at the session history?', onClick: goSessions },
    },
    {
      id: 'cache',
      body: m.avgCache == null ? (
        <>No cache-hit data yet —— once prefix partitioning takes effect, the hit-rate trend shows up here.</>
      ) : (
        <>
          Average cache hit <code>{Math.round(m.avgCache * 100)}%</code>.
          Prefix partitioning {m.avgCache >= 0.3 ? 'is already working' : 'is still low; it will show more on later tasks of the same kind'}.
        </>
      ),
      sparks: cachePts.length ? [
        { label: 'Latest', value: `${Math.round(cachePts[cachePts.length - 1] * 100)}%` },
        { label: 'Average hit', value: `${Math.round((m.avgCache ?? 0) * 100)}%` },
      ] : undefined,
      series: cachePts,
      seriesLabel: 'Cache hit rate',
      fmt: (v) => `${Math.round(v * 100)}%`,
    },
    {
      id: 'verify',
      body: m.verifiedRate == null ? (
        <>No executions with acceptance criteria yet. Once you add acceptance criteria to cards, the pass rate is recorded here.</>
      ) : (
        <>
          Acceptance pass rate <code>{Math.round(m.verifiedRate * 100)}%</code>
          (<code>{m.verifiedTotal}</code> acceptance runs).
          Average turns <code>{num(m.avgTurns)}</code>.
        </>
      ),
      sparks: [
        { label: 'Average turns', value: num(m.avgTurns) },
        { label: 'Executions', value: String(m.total) },
      ],
      series: m.seq.map((r) => r.turns),
      seriesLabel: 'Turns / execution',
      fmt: (v) => String(Math.round(v)),
    },
  ];

  return (
    <div id="metrics">
      <InsightCards pages={insights} />
      <div className="m-panel">
        <div className="m-card"><span className="m-k">Executions</span><span className="m-v">{m.total}</span></div>
        <div className="m-card"><span className="m-k">Total cost</span><span className="m-v">{yuan(m.totalCost)}</span></div>
        <div className="m-card"><span className="m-k">Average cost</span><span className="m-v">{yuan(m.avgCost)}</span></div>
        <div className="m-card"><span className="m-k">Average turns</span><span className="m-v">{num(m.avgTurns)}</span></div>
        <div className="m-card">
          <span className="m-k">Acceptance pass rate</span>
          <span className="m-v">{m.verifiedRate == null ? '—' : `${Math.round(m.verifiedRate * 100)}%`}</span>
          <span className="m-s">{m.verifiedTotal ? `${m.verifiedTotal} acceptance runs` : 'No acceptance criteria'}</span>
        </div>
        <div className="m-card">
          <span className="m-k">Average cache hit</span>
          <span className="m-v">{m.avgCache == null ? '—' : `${Math.round(m.avgCache * 100)}%`}</span>
          <span className="m-s">Prefix-partitioning effectiveness</span>
        </div>
      </div>
      <div className="m-charts">
        <Line series={m.costSeries} fmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toFixed(3))} label="Cost per run (¥)" />
        <Line series={m.cumSeries} fmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toFixed(3))} label="Cumulative cost (¥)" />
        <Line series={m.turnsSeries} fmt={(v) => String(Math.round(v))} label="Turns / execution" />
        <Line series={m.cacheSeries} fixedMax={1} fmt={(v) => `${Math.round(v * 100)}%`} label="Cache hit rate" />
      </div>
      <div className="m-table">
        <div className="m-line-label">Execution details ({m.total} total · 20 per page)</div>
        <RecordsTable
          columns={[
            { key: 'task', label: 'Task', width: '34%', sort: (a, b) => titleOf(a.task_id).localeCompare(titleOf(b.task_id), 'zh'), cell: (r) => <span className="rtable-name" title={r.task_id}>{titleOf(r.task_id)}</span> },
            { key: 'when', label: 'Time', width: '12%', sort: (a, b) => a.created_at - b.created_at, cell: (r) => <span className="rtable-src">{relTime(r.created_at)}</span> },
            { key: 'turns', label: 'Turns', width: '8%', sort: (a, b) => a.turns - b.turns, cell: (r) => <span className="rtable-src">{r.turns}</span> },
            { key: 'cost', label: 'Cost', width: '12%', sort: (a, b) => a.cost - b.cost, cell: (r) => <span className="rtable-src">{yuan(r.cost)}</span> },
            { key: 'hit', label: 'Cache', width: '10%', sort: (a, b) => a.cache_hit - b.cache_hit, cell: (r) => <span className="rtable-src">{Math.round(r.cache_hit * 100)}%</span> },
            { key: 'brief', label: 'Assembled', width: '8%', cell: (r) => <span className="rtable-src">{r.brief_snapshot?.length ?? 0}</span> },
            { key: 'verify', label: 'Accepted', width: '8%', cell: (r) => r.verified == null ? <span className="rtable-src">—</span> : r.verified ? <span className="rtable-str strong">✓</span> : <span className="rtable-str toxic">✗</span> },
            { key: 'outcome', label: 'Outcome', width: '8%', cell: (r) => <span className={'rtable-str ' + (r.outcome === 'Done' ? 'strong' : 'toxic')}>{r.outcome}</span> },
          ]}
          rows={m.seq.slice().reverse().slice(page * 20, (page + 1) * 20)}
          rowKey={(r) => String(r.id)}
          empty={<div className="ph-empty">No execution metrics yet</div>}
        />
        <div className="m-page">
          <button type="button" className="btn mini" disabled={page <= 0} onClick={() => setPage((v) => v - 1)}>Previous</button>
          <span className="m-page-info">Page {page + 1} / {Math.max(1, Math.ceil(m.seq.length / 20))}</span>
          <button type="button" className="btn mini" disabled={(page + 1) * 20 >= m.seq.length} onClick={() => setPage((v) => v + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
