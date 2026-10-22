// Responsibility: Sidebar —— project list (two lines: name + small status stats / status dot / collapse / filter input) + new project + settings entry.
// Status dot: running blue > awaiting confirmation yellow > idle gray; stats: running/failed/done; busy count badge. Sidebar collapsing is controlled by App via #approw.side-off.
// Sliding highlight: port of Beautiful UI's "Sidebar Nav" (MIT © Shane Levine) —— glide bar for hover/current item.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUi, writeHash } from '../../store/ui';
import { useProjection, cardStatus, type Project } from '../../store/projection';
import { Icon } from '../icons';
import { BrandMark } from '../BrandMark';
import { RemoveProjectModal } from '../modals/RemoveProjectModal';

export function Sidebar() {
  const pid = useUi((s) => s.pid);
  const sideQ = useUi((s) => s.sideQ);
  const setSideQ = useUi((s) => s.setSideQ);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const setDirOpen = useUi((s) => s.setDirOpen);
  const projects = useProjection((s) => s.projects);
  const cards = useProjection((s) => s.cards);
  const pending = useUi((s) => s.pendingProjects);
  // Project pending removal (sidebar hover ✕ → shares the same confirmation dialog as the home/project pages)
  const [removeTarget, setRemoveTarget] = useState<{ pid: string; name: string } | null>(null);

  const list = useMemo(() => {
    const q = sideQ.trim().toLowerCase();
    const reg = Object.values(projects).map((p) => ({ ...p, pending: false as boolean }));
    const pen = Object.values(pending).map((p) => ({ id: p.id, name: p.name, path: p.path, card_count: 0, counts: undefined as Project['counts'], pending: true as boolean }));
    return [...reg, ...pen]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [projects, pending, sideQ]);

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);

  const glideTo = (el: HTMLDivElement | null) => {
    if (!el) { setHl(null); return; }
    setHl({ top: el.offsetTop, height: el.offsetHeight });
  };

  useLayoutEffect(() => {
    const i = list.findIndex((p) => p.id === pid);
    glideTo(itemRefs.current[i] ?? null);
  }, [pid, list]);

  return (
    <aside id="sidebar">
      <div className="side-brand">
        <div className="app-badge"><BrandMark size={24} /></div>
        <b>Helmsman</b>
      </div>
      <div className="side-filter">
        <Icon name="search" size="sm" />
        <input value={sideQ} onChange={(e) => setSideQ(e.target.value)} placeholder="Filter projects" aria-label="Filter projects" />
      </div>
      <div className="side-label">Projects</div>
      <div
        id="side-projects"
        ref={listRef}
        onMouseLeave={() => {
          const i = list.findIndex((p) => p.id === pid);
          glideTo(itemRefs.current[i] ?? null);
        }}
      >
        {hl ? <span className="side-glide" style={{ top: hl.top, height: hl.height, opacity: 1 }} /> : null}
        {list.length === 0 && <div className="side-empty">No matching projects</div>}
        {list.map((p, k) => {
          const c = p.counts
            ? { Pending: p.counts[0], Running: p.counts[1], Done: p.counts[2], Failed: p.counts[3], Cancelled: p.counts[4] }
            : cardCountsLocal(Object.values(cards[p.id] || {}));
          const active = p.id === pid;
          const dotColor = c.Running > 0 ? 'var(--blue)' : '';
          const stats: string[] = [];
          if (c.Running) stats.push(c.Running + ' running');
          if (c.Failed) stats.push(c.Failed + ' failed');
          if (c.Done) stats.push(c.Done + ' done');
          if (p.pending) stats.push('pending registration');
          const busy = c.Running;
          return (
            <div
              key={p.id}
              ref={(el) => { itemRefs.current[k] = el; }}
              className={'side-item' + (active ? ' active' : '')}
              style={{ ['--i' as string]: k }}
              onMouseEnter={() => glideTo(itemRefs.current[k])}
              onClick={() => {
                useUi.getState().setRoute({ pid: p.id, view: 'projhome', openId: null, tab: 'comments', sessionId: null });
                writeHash(p.id, 'projhome', null, 'comments');
              }}
            >
              <span className="sdot" style={dotColor ? { background: dotColor } : undefined} />
              <div className="side-main">
                <div className="sname">{p.name}{p.pending ? <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 6 }}>new</span> : null}</div>
                <div className="sstats">{stats.join(' · ') || 'Idle'}</div>
              </div>
              {busy ? <span className="scount">{busy}</span> : null}
              {!p.pending && (
                <button
                  className="side-rm"
                  title="Remove project"
                  aria-label={'Remove project ' + p.name}
                  onClick={(e) => { e.stopPropagation(); setRemoveTarget({ pid: p.id, name: p.name }); }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="side-foot">
        <button className="side-new" onClick={() => setDirOpen(true)}>
          <Icon name="plus" size="sm" />New project
        </button>
        <button className="side-set" onClick={() => setSettingsOpen(true)}>
          <Icon name="gear" size="sm" />Settings
        </button>
      </div>
      {removeTarget ? (
        <RemoveProjectModal pid={removeTarget.pid} name={removeTarget.name} onClose={() => setRemoveTarget(null)} />
      ) : null}
    </aside>
  );
}

/** Card counts (by each card's latest execution status; no execution = Pending) —— local fallback when the server's counts are missing */
function cardCountsLocal(cards: import('../../store/projection').CardState[]): { Pending: number; Running: number; Done: number; Failed: number; Cancelled: number } {
  const out = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0 };
  cards.forEach((c) => {
    const st = cardStatus(c);
    if (st === 'Pending' || st === 'Running' || st === 'Done' || st === 'Failed' || st === 'Cancelled') out[st] += 1;
  });
  return out;
}