// Responsibility: collapsible thinking (port of Beautiful UI's "Thinking", MIT © Shane Levine) ——
//   four forms: steps / reasoning / search / coding. Tabs only expose the forms the current group actually has —— not a fake switch.
import { useMemo, useState, type ReactNode } from 'react';

export type ThinkRowKind = 'think' | 'tool' | 'text';
export type ThinkVariant = 'steps' | 'reasoning' | 'search' | 'coding';

export interface ThinkRow {
  id: string | number;
  kind: ThinkRowKind;
  /** Content of a think/text row */
  text?: string;
  /** tool row: tool name */
  name?: string;
  /** tool row: arguments (shown when expanded, monospace and truncated) */
  args?: string;
  err?: boolean;
  /** tool row duration / custom info on the right */
  ms?: number;
  meta?: string;
  /** Timestamp (epoch ms, used for interleaved message sorting) */
  at?: number;
}

const VARIANTS: { id: ThinkVariant; label: string }[] = [
  { id: 'steps', label: 'Steps' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'search', label: 'Search' },
  { id: 'coding', label: 'Coding' },
];

function isSearchTool(name?: string): boolean {
  return !!name && /search|kb|web|grep|fetch|lookup|query|find/i.test(name);
}

function queryOf(r: ThinkRow): string {
  const raw = r.args?.trim();
  if (raw) {
    try {
      const j = JSON.parse(raw) as unknown;
      if (typeof j === 'string') return j;
      if (j && typeof j === 'object') {
        const o = j as Record<string, unknown>;
        const v = o.query ?? o.q ?? o.pattern ?? o.search ?? o.path ?? o.keyword;
        if (typeof v === 'string' && v.trim()) return v;
      }
    } catch { /* not JSON, use it as the query as-is */ }
    return raw.length > 96 ? raw.slice(0, 96) + '…' : raw;
  }
  return r.name ?? '';
}

function availableOf(rows: ThinkRow[]): ThinkVariant[] {
  const tools = rows.filter((r) => r.kind === 'tool');
  const hasThink = rows.some((r) => r.kind === 'think' || r.kind === 'text');
  const hasSearch = tools.some((t) => isSearchTool(t.name));
  const hasCode = tools.some((t) => !isSearchTool(t.name));
  const out: ThinkVariant[] = [];
  if (rows.length) out.push('steps');
  if (hasThink) out.push('reasoning');
  if (hasSearch) out.push('search');
  if (hasCode) out.push('coding');
  return out;
}

function rowsFor(rows: ThinkRow[], variant: ThinkVariant): ThinkRow[] {
  if (variant === 'reasoning') return rows.filter((r) => r.kind === 'think' || r.kind === 'text');
  if (variant === 'search') return rows.filter((r) => r.kind === 'tool' && isSearchTool(r.name));
  if (variant === 'coding') return rows.filter((r) => r.kind === 'tool' && !isSearchTool(r.name));
  return rows;
}

interface Props {
  rows: ThinkRow[];
  /** Running: the title shimmers + expanded by default */
  running?: boolean;
  label?: string;
  defaultOpen?: boolean;
  /** Extra content for the expanded area (e.g. the streaming tail) */
  children?: ReactNode;
}

export function Thinking({ rows, running = false, label, defaultOpen, children }: Props) {
  const [open, setOpen] = useState(defaultOpen ?? running);
  const available = useMemo(() => availableOf(rows), [rows]);
  const [picked, setPicked] = useState<ThinkVariant | null>(null);
  const variant = picked && available.includes(picked) ? picked : (available[0] ?? 'steps');
  const shown = rowsFor(rows, variant);
  const text = label ?? (running ? 'Thinking…' : 'Thought process');

  return (
    <div className={'think' + (open ? ' open' : '')} data-variant={variant}>
      <button
        type="button"
        className="think-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="spark" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.2 9.6 6l4.8 1.6-4.8 1.6L8 14l-1.6-4.8L1.6 7.6 6.4 6z" />
        </svg>
        <span className={'think-label' + (running ? ' live' : '')}>{text}</span>
        {rows.length > 0 ? <span className="think-count">{rows.length}</span> : null}
        <svg
          className="think-chev"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className="think-body">
        <div className="think-body-inner">
          <div className="think-trace">
            {shown.map((r, i) => {
              const live = running && i === shown.length - 1;
              const done = !live && (r.kind !== 'tool' || !r.err);
              if (variant === 'reasoning') {
                return (
                  <div key={r.id} className="think-reason" data-kind={r.kind}>
                    {r.text}
                  </div>
                );
              }
              if (variant === 'search') {
                return (
                  <div key={r.id} className={'think-hit' + (live ? ' live' : '')} data-kind="tool">
                    <span className="think-hit-q">{queryOf(r)}</span>
                    {r.err ? <span className="err">failed</span> : live ? <span className="tmeta">searching</span> : <span className="ok">hit</span>}
                    {r.ms != null ? <span className="tmeta">{r.ms} ms</span> : null}
                  </div>
                );
              }
              if (variant === 'coding') {
                return (
                  <div key={r.id} className={'think-code' + (live ? ' live' : '')} data-kind="tool">
                    <div className="think-code-bar">
                      <span className="tname">{r.name}</span>
                      <span className={r.err ? 'err' : live ? 'tmeta' : 'ok'}>{r.err ? 'failed' : live ? 'running' : 'ok'}</span>
                      {r.ms != null ? <span className="tmeta">{r.ms} ms</span> : null}
                    </div>
                    {r.args ? <div className="targs">{r.args}</div> : null}
                  </div>
                );
              }
              return (
                <div
                  key={r.id}
                  className={'think-step' + (live ? ' live' : done ? ' done' : '') + (r.err ? ' fail' : '')}
                  data-kind={r.kind}
                >
                  <span className="think-n" aria-hidden="true">{r.err ? '!' : done ? '✓' : i + 1}</span>
                  {r.kind === 'tool' ? (
                    <>
                      <span className="tname">{r.name}</span>
                      {r.ms != null ? <span className="tmeta">{r.ms} ms</span> : null}
                    </>
                  ) : (
                    <span className="ttxt" title={r.text}>{r.text}</span>
                  )}
                </div>
              );
            })}
            {children}
            {shown.length === 0 && !children ? <div className="think-empty">(empty)</div> : null}
          </div>
          {available.length > 1 ? (
            <div className="think-tabs">
              {VARIANTS.filter((t) => available.includes(t.id)).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={'think-tab' + (variant === t.id ? ' active' : '')}
                  onClick={() => setPicked(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
