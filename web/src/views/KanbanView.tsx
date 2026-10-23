// Responsibility: board —— five columns (Pending/Running/Failed/Done/Cancelled; the Running column includes Waiting from the target contract).
// M2.3 (O1=B): the board shows **asset cards** —— card status = status of the latest execution; cards show milestone + execution count;
// click a card → detail drawer (all execution generations, can fork).
// Card information hierarchy: title + milestone badge → dependency chips (target contract) → last activity → executions ×N → action row.
// Red line 1: the frontend never changes state —— drag / run / rerun all send events (the real contract only has POST cards/executions; the rest are target-contract placeholders).
// Blocked (unfinished dependencies) is computed on every render (depsUnmet), never written to a state field.
import { useMemo, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import {
  useProjection, cardStatus, latestExecution, cardUnmet, activityText, fmtTime,
  type CardState, type TaskState,
} from '../store/projection';
import { LoadingState } from '../components/LoadingState';

const COLS: { key: TaskState['status']; label: string }[] = [
  { key: 'Pending', label: 'To do' },
  { key: 'Running', label: 'In progress' },
  { key: 'Failed', label: 'Failed' },
  { key: 'Done', label: 'Done' },
  { key: 'Cancelled', label: 'Cancelled' },
];

export function KanbanView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const conn = useProjection((s) => s.conn);
  const loading = useProjection((s) => s.loading);
  const toast = useUi((s) => s.toast);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [milestoneFilter, setMilestoneFilter] = useState<string | null>(null);

  const all = useMemo(() => Object.values(cards), [cards]);
  const byId = useMemo(() => cards, [cards]);

  const openDetail = (cardId: string) => {
    useUi.getState().setRoute({ openId: cardId, tab: 'comments' });
    writeHash(pid, 'kanban', cardId, 'comments');
  };

  const runCard = async (c: CardState) => {
    // §2.1 scheduling gate: unfinished dependencies → server returns 409 (the frontend already disables the button, belt and braces)
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    const sid = await useProjection.getState().forkExecution(c.id, undefined);
    if (sid) toast('Execution started');
  };

  const retryCard = async (c: CardState) => {
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    const sid = await useProjection.getState().forkExecution(c.id, undefined);
    if (sid) toast('Rerun = new execution generation (the original event stream is kept for diffing)');
  };

  const onDrop = async (c: CardState, target: string) => {
    const st = cardStatus(c);
    if (st === 'Running' || st === 'Waiting') return; // locked
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    // Red line 1: drag = event (POST /api/cards/:id/status, manual-mark semantics)
    const map: Record<string, 'Done' | 'Failed' | 'Pending'> = { done: 'Done', fail: 'Failed', todo: 'Pending' };
    const status = map[target];
    if (!status) return;
    const ok = await useProjection.getState().markCardStatus(c.id, status);
    toast(ok ? `Manually marked "${target}" (event API · status is auditable)` : 'Marking failed, see the error banner');
  };

  if (loading && !all.length) {
    return (
      <div className="kanban-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingState variant="drive" label="Loading board…" />
      </div>
    );
  }

  const milestones = [...new Set(all.map((c) => c.milestone).filter((m): m is string => !!m))].sort((a, b) => a.localeCompare(b, 'zh'));

  return (
    <div className="kanban-wrap">
      {milestones.length > 0 ? (
        <div className="kbar" role="tablist" aria-label="Filter by milestone">
          <span className="kbar-label">Milestone</span>
          <button
            type="button"
            className={'kbar-chip' + (milestoneFilter === null ? ' active' : '')}
            onClick={() => setMilestoneFilter(null)}
          >All</button>
          {milestones.map((m) => {
            const done = all.filter((c) => c.milestone === m && cardStatus(c) === 'Done').length;
            const total = all.filter((c) => c.milestone === m).length;
            return (
              <button
                type="button"
                key={m}
                className={'kbar-chip' + (milestoneFilter === m ? ' active' : '')}
                onClick={() => setMilestoneFilter(milestoneFilter === m ? null : m)}
                title={`${m}: ${done}/${total} done`}
              >
                {m}
                <span className="kbar-count">{done}/{total}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div id="kanban">
      {COLS.map((col) => {
        const items = all.filter((c) => {
          if (milestoneFilter && c.milestone !== milestoneFilter) return false;
          const st = cardStatus(c);
          return col.key === 'Running' ? st === 'Running' || st === 'Waiting' : st === col.key;
        });
        const headCount = items.length;
        return (
          <div
            key={col.key}
            className={'kcol' + (dropCol === col.key ? ' droptarget' : '')}
            data-col={col.key}
            onDragOver={(e) => { e.preventDefault(); if (dragId) setDropCol(col.key); }}
            onDragLeave={() => setDropCol(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropCol(null);
              const id = dragId || e.dataTransfer.getData('text/plain');
              setDragId(null);
              const c = byId[id];
              if (c) onDrop(c, col.key);
            }}
          >
            <div className="kcol-head">
              <span className={'dot ' + col.key} />
              {col.label}
              <span className="count">{headCount}</span>
            </div>
            <div className="kcol-body">
              {items.length === 0 && <div className="kempty">Empty</div>}
              {items.map((c, k) => {
                const st = cardStatus(c);
                const locked = st === 'Running' || st === 'Waiting';
                const exec = latestExecution(c);
                const unmet = cardUnmet(c, byId);
                const lastAct = exec && exec.activities.length ? exec.activities[exec.activities.length - 1] : null;
                let act: React.ReactNode = null;
                if (st === 'Pending') {
                  act = unmet.length
                    ? <span className="run-state">Waiting on upstream: {unmet.join(', ')}</span>
                    : <button className="btn mini" onClick={(e) => { e.stopPropagation(); void runCard(c); }}>Run</button>;
                } else if (st === 'Running') {
                  act = <span className="run-state">Running · locked (control via comments)</span>;
                } else if (st === 'Waiting') {
                  act = <span className="waiting-q">Awaiting approval · locked</span>;
                } else if (st === 'Failed' || st === 'Cancelled') {
                  act = <button className="btn mini ghost" onClick={(e) => { e.stopPropagation(); void retryCard(c); }}>Rerun</button>;
                }
                return (
                  <div
                    key={c.id}
                    className={'kcard st-' + st + (locked ? ' locked' : '')}
                    style={{ ['--i' as string]: k }}
                    draggable={!locked}
                    onDragStart={(e) => {
                      if (locked) { e.preventDefault(); return; }
                      setDragId(c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', c.id);
                      e.currentTarget.classList.add('dragging');
                    }}
                    onDragEnd={(e) => {
                      e.currentTarget.classList.remove('dragging');
                      setDragId(null);
                      setDropCol(null);
                    }}
                    onClick={() => openDetail(c.id)}
                  >
                    <div className="kt">
                      {c.title || c.id.slice(0, 14)}
                      {c.milestone ? <span className="milestone-chip">{c.milestone}</span> : null}
                      {exec?.recovered ? <span className="rec">Recovered</span> : null}
                      {locked ? <span className="lock-tag">🔒</span> : null}
                    </div>
                    {unmet.length ? <div className="ksum"><span className="dep blocked">← {unmet.join(', ')}</span></div> : null}
                    {lastAct ? (
                      <div className="ksum">
                        <span className="ellip">{fmtTime(exec?.started_at ?? exec?.finished_at)} · {activityText(lastAct).slice(0, 26)}</span>
                      </div>
                    ) : null}
                    <div className="ksum kexec">
                      <span className="exec-count">⚙ Executions ×{c.execution_count ?? Object.keys(c.executions).length}</span>
                      {exec?.model ? <span className="ellip">{exec.model}</span> : null}
                    </div>
                    <div className="kact">{act}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
