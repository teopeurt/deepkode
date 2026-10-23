// Responsibility: knowledge chunk cards (port of Beautiful UI's "Context Cards", MIT © Shane Levine) ——
//   title bar (list icon + title + character count) + content summary (truncated to 3 lines by default) + source chip (colored by extension/source type) + relevance/badges.
// Source colors: pdf→red / csv→green / md·task→blue / human→green / chat→gray; uses existing semantic tokens (--red/--green/--blue/--gray).
export type ChunkBadgeTone = 'ok' | 'info' | 'warn' | 'muted';

export interface ChunkBadge {
  label: string;
  tone: ChunkBadgeTone;
}

export interface ContextChunk {
  id: string | number;
  title: string;
  /** Click the card (e.g. jump to details) */
  onClick?: () => void;
  content?: string;
  /** Character count (shown on the right of the title bar; hidden if not passed) */
  chars?: number;
  sourceKind?: string;
  sourceRef?: string;
  /** Relevance 0-1 (shown as a percentage) */
  score?: number;
  badges?: ChunkBadge[];
  /** Whether content is truncated to 3 lines (default true) */
  clamp?: boolean;
}

const KIND_EXT: Record<string, { label: string; cls: string }> = {
  pdf: { label: 'PDF', cls: 'pdf' },
  csv: { label: 'CSV', cls: 'csv' },
  md: { label: 'MD', cls: 'md' },
  markdown: { label: 'MD', cls: 'md' },
  task: { label: 'Task', cls: 'task' },
  human: { label: 'Human', cls: 'human' },
  chat: { label: 'Chat', cls: 'chat' },
};

const BADGE_TONE: Record<ChunkBadgeTone, string> = {
  ok: 'human-approved',   // green
  info: 'agent-generated', // blue
  warn: 'unverified',     // gray
  muted: 'unverified',
};

export interface ContextCardsProps {
  chunks: ContextChunk[];
  title?: string;
  /** Header count text; defaults to chunks.length */
  countLabel?: string;
  empty?: string;
  /** Whether to render the header title row (default true; can be turned off when embedded) */
  showHead?: boolean;
}

export function ContextCards({ chunks, title = 'Knowledge chunks', countLabel, empty, showHead = true }: ContextCardsProps) {
  return (
    <div className="ctx">
      {showHead ? (
        <div className="ctx-head">
          <span className="t">{title}</span>
          <span className="ctx-count">{countLabel ?? chunks.length}</span>
        </div>
      ) : null}
      {chunks.length === 0 && empty ? <div className="ph-empty">{empty}</div> : null}
      {chunks.map((c) => {
        const ext = c.sourceKind ? KIND_EXT[c.sourceKind.toLowerCase()] : undefined;
        return (
          <div key={c.id} className="ctx-card" onClick={c.onClick} role={c.onClick ? 'button' : undefined} style={c.onClick ? { cursor: 'pointer' } : undefined}>
            <div className="ctx-bar">
              <svg className="bar-ic" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h7" />
              </svg>
              <span className="bt" title={c.title}>{c.title}</span>
              {c.chars != null ? <span className="bc">{c.chars.toLocaleString()} chars</span> : null}
            </div>
            {c.content ? <div className={'ctx-body' + (c.clamp === false ? '' : ' clamp')}>{c.content}</div> : null}
            <div className="ctx-foot">
              {ext || c.sourceRef ? (
                <span className="ctx-src" title={c.sourceRef}>
                  {ext ? <span className={'ext ' + ext.cls}>{ext.label}</span> : null}
                  {c.sourceRef ? <span className="ref">{c.sourceRef}</span> : null}
                </span>
              ) : null}
              {c.badges && c.badges.length > 0 ? (
                <span className="ctx-badges">
                  {c.badges.map((b) => (
                    <span key={b.label} className={'trust ' + BADGE_TONE[b.tone]}>{b.label}</span>
                  ))}
                </span>
              ) : null}
              {c.score != null ? <span className="ctx-score">{Math.round(c.score * 100)}%</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
