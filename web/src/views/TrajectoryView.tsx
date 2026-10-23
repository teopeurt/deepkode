// Responsibility: trajectory session view (modeled on the dsh ui-trajectory mechanism, no code copied) ——
//   virtualized window (only visible rows + a buffer are rendered, smooth with 200+ rows), scroll anchoring (follows the tail by default, scrolling up pauses following),
//   streaming-tail isolation (while Running, new activities are only appended at the tail), turn grouping + tool call/result merging.
// The data model reuses the drawer's toRows (activities → rows); the interaction mechanics are redone after the dsh design.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Activity, TaskState } from '../store/projection';
import { useProjection, estCost, cacheHitOf } from '../store/projection';

export interface TrajRow {
  idx: number;
  turn: number;
  at?: number;
  kind: 'text' | 'think' | 'tool';
  name?: string;
  args?: string;
  err?: boolean;
  text?: string;
  ms?: number;
}

/** Activities → trajectory rows (merges ToolStart/ToolResult; carries at/turn for grouping and durations) */
export function toRows(t: TaskState): TrajRow[] {
  const toolById: Record<string, { args: string }> = {};
  (t.tool_calls || []).forEach((tc) => { toolById[tc.call_id] = tc; });
  const rows: TrajRow[] = [];
  const acts = t.activities;
  let i = 0;
  while (i < acts.length) {
    const a: Activity = acts[i];
    if ('ToolStart' in a) {
      let res: Activity | null = null;
      let j = i + 1;
      if (j < acts.length && 'ToolResult' in acts[j]) { res = acts[j]; j++; }
      const tr = res && 'ToolResult' in res ? res.ToolResult : null;
      const startAt = a.ToolStart.at;
      rows.push({
        idx: i, turn: a.ToolStart.turn ?? 0, at: startAt,
        kind: 'tool', name: a.ToolStart.name,
        args: tr ? toolById[tr.name]?.args : '',
        err: tr ? tr.is_error : false,
        ms: startAt != null && tr?.at != null ? Math.max(0, tr.at - startAt) : undefined,
      });
      i = j;
    } else if ('Reasoning' in a) {
      rows.push({ idx: i, turn: a.Reasoning.turn ?? 0, at: a.Reasoning.at, kind: 'think', text: a.Reasoning.text }); i++;
    } else if ('Text' in a) {
      rows.push({ idx: i, turn: a.Text.turn ?? 0, at: a.Text.at, kind: 'text', text: a.Text.text }); i++;
    } else { i++; }
  }
  return rows;
}

// ---------- Virtualization parameters ----------
const ROW_H = 32;        // estimated row height (px)
const BUFFER = 10;       // buffer rows above/below the window
const OVERSCAN = 60;     // distance from the bottom that counts as "at the bottom" (px)

interface Props {
  task: TaskState;
  stream?: string;
  /** Historical usage backfill (metrics table; shows cost/budget when there is no live WS usage) */
  usageOverride?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number };
}

export function TrajectoryView({ task, stream, usageOverride }: Props) {
  const usage = useProjection((s) => s.usage);
  const liveUsage = usage[task.id];
  const execUsage = liveUsage ?? usageOverride;
  const cost = estCost(execUsage, task?.model);
  const hit = cacheHitOf(execUsage);
  const rows = useMemo(() => toRows(task), [task]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Anchoring state: 'tail' = follow the tail; 'paused' = the user scrolled up, following paused
  const [follow, setFollow] = useState<'tail' | 'paused'>('tail');
  // Visible window [start, end)
  const [range, setRange] = useState<[number, number]>([0, 40]);
  const total = rows.length + (stream ? 1 : 0);

  const running = task.status === 'Running' || (task.waiting !== null && task.waiting !== undefined);

  // Scroll container height: adapts to fill the parent (.traj-scroll height:100%), no longer hard-coded to 320px
  // (hard-coding it made the trajectory take only half the space, leaving blank space below)

  // Scroll handling: decide whether we are at the bottom (anchor to tail) or the user scrolled up (pause following)
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < OVERSCAN) {
      if (follow === 'paused') setFollow('tail');
    } else {
      setFollow('paused');
    }
    // Compute the visible window
    const firstVisible = Math.max(0, Math.floor(el.scrollTop / ROW_H) - BUFFER);
    const visibleCount = Math.ceil(el.clientHeight / ROW_H) + BUFFER * 2;
    setRange([firstVisible, Math.min(total, firstVisible + visibleCount)]);
  };

  // Streaming/data changes: if following the tail, scroll to the bottom; if paused, keep the position (don't interrupt inspection)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow === 'tail') {
      el.scrollTop = el.scrollHeight;
      // Sync the window to the bottom
      const last = Math.max(0, Math.ceil(el.scrollHeight / ROW_H) - 1);
      const visibleCount = Math.ceil(el.clientHeight / ROW_H) + BUFFER * 2;
      setRange([Math.max(0, last - visibleCount), Math.min(total, last + BUFFER)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, follow]);

  // Anchor to the tail on first mount
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const base = task.started_at ?? rows[0]?.at;
  const offset = (at?: number): string => {
    if (at == null || base == null) return '';
    const ms = at - base;
    return '+' + (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  };

  // Group by turn (only the rows inside the window are grouped, keeping the structure)
  const groups = useMemo(() => {
    const [start, end] = range;
    const out: { turn: number; rows: TrajRow[] }[] = [];
    for (let i = start; i < end && i < rows.length; i++) {
      const r = rows[i];
      const g = out[out.length - 1];
      if (!g || g.turn !== r.turn) out.push({ turn: r.turn, rows: [r] });
      else g.rows.push(r);
    }
    return out;
  }, [rows, range]);

  const topPad = range[0] * ROW_H;
  const bottomPad = Math.max(0, (rows.length - range[1]) * ROW_H);

  return (
    <div className="traj-wrap">
      <div className="traj-scroll" ref={scrollRef} onScroll={onScroll} style={{ overflowY: 'auto' }}>
      <div className="sess-meta">
        <span className="kv">Model <b>{task.model || '-'}</b></span>
        <span className="kv">Turns <b>{task.turns ?? 0}</b></span>
        <span className="kv">Steps <b>{task.steps ?? 0}</b></span>
        <span className="kv">seq <b>{task.last_seq ?? 0}</b></span>
        {follow === 'paused' ? <span className="traj-follow-hint" title="Click to jump to the latest">⏸ Following paused · scroll to the bottom to resume</span> : null}
      </div>

      {groups.length === 0 && !stream && <div className="ph-empty">No trajectory yet (the engine is running or has not started)</div>}

      {/* Virtualization: top spacer + visible rows + bottom spacer */}
      {topPad > 0 ? <div style={{ height: topPad }} /> : null}
      {groups.map((g) => (
        <div key={g.turn} className="traj-group">
          <div className="traj-group-head">Turn {g.turn || 1}</div>
          {g.rows.map((r) => renderRow(r, offset(r.at)))}
        </div>
      ))}
      {bottomPad > 0 ? <div style={{ height: bottomPad }} /> : null}

      {running && stream ? (
        <div className="traj-row" data-kind="text" data-stream="true">
          <span className="traj-dot" />
          <span className="traj-index">▌</span>
          <span className="traj-text">{stream}</span>
        </div>
      ) : null}
      {running ? <div className="sess-caret">▌</div> : null}

      </div>
      {execUsage ? (
        <div className="cost-block">
          <div className="t">Turn cost (this execution)</div>
          <div className="cost-row">
            <span>
              Input {execUsage.inputTokens.toLocaleString()} · Output {execUsage.outputTokens.toLocaleString()} · Cache read {execUsage.cacheReadTokens.toLocaleString()} · Reasoning {execUsage.reasoningTokens.toLocaleString()}
            </span>
          </div>
          <div className="cost-row"><span>Cache hit rate (this execution)</span><b>{hit == null ? '—' : Math.round(hit * 100) + '%'}</b></div>
          <div className="cost-row total"><span>Estimate</span><span>¥ {cost == null ? '—' : cost.toFixed(4)}</span></div>
        </div>
      ) : null}
    </div>
  );
}

function renderRow(r: TrajRow, time: string) {
  if (r.kind === 'think') {
    return (
      <details key={r.idx} className="traj-row" data-kind="think">
        <summary className="traj-main">
          <span className="traj-dot" />
          <span className="traj-index">#{r.idx + 1}</span>
          <span className="traj-text">{r.text?.slice(0, 60) || 'Thinking'}</span>
          <span className="traj-time">{time}</span>
        </summary>
        <div className="traj-detail think">{r.text}</div>
      </details>
    );
  }
  if (r.kind === 'tool') {
    const isErr = r.err;
    return (
      <details key={r.idx} className="traj-row" data-kind="tool" data-err={isErr || undefined}>
        <summary className="traj-main">
          <span className="traj-dot" />
          <span className="traj-index">#{r.idx + 1}</span>
          <span className="traj-tool-name">{r.name}</span>
          <span className={r.err ? 'err' : 'ok'}>{r.err ? 'failed' : 'ok'}</span>
          {r.ms != null ? <span className="traj-ms">{r.ms} ms</span> : null}
          <span className="traj-time">{time}</span>
        </summary>
        {r.args ? <div className="traj-detail mono">{r.args}</div> : null}
      </details>
    );
  }
  const errCls = (r.text || '').indexOf('Failed') === 0 ? ' err' : '';
  return (
    <div key={r.idx} className="traj-row" data-kind="text">
      <span className="traj-dot" />
      <span className="traj-index">#{r.idx + 1}</span>
      <span className={'traj-text' + errCls}>{r.text}</span>
      <span className="traj-time">{time}</span>
    </div>
  );
}
