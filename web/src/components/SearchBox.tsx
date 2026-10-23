// Responsibility: command search (port of Beautiful UI's "Search", MIT © Shane Levine) ——
//   input row (icon + placeholder) + result list (live filtering) + sliding highlight bar (glide) + keyboard navigation (↑↓/Enter) + empty state.
//   Pure client-side filtering: the caller provides items + filter; the component owns the query and highlight state.
import { useRef, useState } from 'react';

export interface SearchItem {
  id: string | number;
  title: string;
  sub?: string;
  onSelect?: () => void;
}

interface Props {
  placeholder?: string;
  /** Required in menu mode (the default); optional in bare mode */
  items?: SearchItem[];
  filter?: (item: SearchItem, q: string) => boolean;
  emptyText?: string;
  /** Controlled mode: the query is owned externally (needed to keep list filtering in sync) */
  value?: string;
  onValue?: (q: string) => void;
  /** bare = input only (no result list is rendered; the caller shows results in its own list below, fully reusing existing rendering) */
  bare?: boolean;
}

export function SearchBox({ placeholder = 'Search…', items = [], filter = () => true, emptyText = 'No matches', value, onValue, bare = false }: Props) {
  const [q0, setQ0] = useState('');
  const [active, setActive] = useState(-1);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const q = value ?? q0;
  const setQ = (v: string) => {
    if (onValue) onValue(v);
    else setQ0(v);
  };

  const shown = q.trim() ? items.filter((it) => filter(it, q.trim())) : items;

  // bare mode: only the input row; keyboard navigation / result list are entirely the caller's job
  if (bare) {
    return (
      <div className="searchbox">
        <div className="searchbox-input">
          <svg className="sic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>
      </div>
    );
  }

  // Sliding highlight: move the glide bar to the given row (reads DOM offsetTop, which is ready at event time)
  const glide = (i: number) => {
    const el = rowsRef.current[i];
    if (el) {
      setHl({ top: el.offsetTop, height: el.offsetHeight });
      setActive(i);
    } else {
      setHl(null);
      setActive(-1);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      glide(active < 0 ? 0 : Math.min(active + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      glide(active < 0 ? shown.length - 1 : Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      shown[active].onSelect?.();
    }
  };

  return (
    <div className="searchbox">
      <div className="searchbox-input">
        <svg className="sic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(-1); setHl(null); }}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <div className="searchbox-menu">
        {hl ? <span className="searchbox-glide" style={{ top: hl.top, height: hl.height, opacity: 1 }} /> : null}
        {shown.map((it, i) => (
          <button
            key={it.id}
            type="button"
            ref={(el) => { rowsRef.current[i] = el; }}
            className="searchbox-row"
            onMouseEnter={() => glide(i)}
            onClick={it.onSelect}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
            {it.sub ? <span className="sub">{it.sub}</span> : null}
          </button>
        ))}
        {q.trim() && shown.length === 0 ? <div className="searchbox-empty">{emptyText}</div> : null}
      </div>
    </div>
  );
}
