// Responsibility: card detail drawer —— M2.3 (O1=B) two layers, card/execution:
//   card header (title + milestone + status = latest execution); an "execution generation" selector bar (the N in 1 card N executions; switchable + fork a new generation);
//   the comments/brief/artifact/trajectory tabs act on the **selected execution** (= session).
// Comments = the user's control channel (the server only folds user/message); the agent's execution process belongs to the "trajectory".
// Trajectory = the dsh trajectory model (see packages/client/ui-trajectory): grouped by turn, each row is #N · type tag · one-line summary ·
// offset time; tool rows merge call+result (name / success / argument details / duration); a cost block + streaming tail at the bottom.
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash, openSession, type DrawerTab } from '../store/ui';
import { listApprovals, decideApproval, getMetrics, MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL } from '../api/client';
import {
  useProjection, effectiveStatus, cardStatus, cardUnmet, waitingLabel, fmtTime,
  latestExecution, executionList,
  type TaskState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { TrajectoryView } from './TrajectoryView';
import { Markdown } from '../components/Markdown';
import { AcceptanceEvidence } from '../components/AcceptanceEvidence';
import { ContextCards } from '../components/ContextCards';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import type { KbNoteRow } from '../api/client';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'comments', label: 'Comments' },
  { id: 'brief', label: 'Brief' },
  { id: 'artifact', label: 'Artifacts' },
  { id: 'trajectory', label: 'Trajectory' },
];

export function TaskDetailDrawer({ pid, cardId }: { pid: string; cardId: string }) {
  const tab = useUi((s) => s.tab);
  const card = useProjection((s) => s.cards[pid]?.[cardId]);
  const usage = useProjection((s) => s.usage);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const projects = useProjection((s) => s.projects);
  const toast = useUi((s) => s.toast);

  // Selected execution generation (defaults to the latest; if the selected one disappears after the card refreshes, fall back to the latest)
  const execs = executionList(card);
  const [selSid, setSelSid] = useState<string | null>(null);
  const selSidEffective = selSid && card?.executions[selSid] ? selSid : (latestExecution(card)?.id ?? null);
  const task = selSidEffective ? card?.executions[selSidEffective] : undefined;
  const sid = task?.id ?? selSidEffective ?? '';
  const execUsage = usage[sid];
  const stream = streams[sid];
  const cardExecs = card ? Object.values(card.executions) : [];
  const byId: Record<string, TaskState> = {};
  cardExecs.forEach((e) => { byId[e.id] = e; });
  // Dependency contract (target contract: taskgraph): deps are card ids → the card's latest execution; scan in reverse for dependents
  const allCards = useProjection((s) => s.cards[pid] || {});
  const revDeps = Object.values(allCards)
    .filter((c) => c.deps?.includes(cardId))
    .map((c) => ({ id: c.id, title: c.title, status: cardStatus(c) }));

  // Brief snapshot (metrics.brief_snapshot, by execution sid) and card artifacts (KB notes with source_ref=cardId)
  const [briefRows, setBriefRows] = useState<Record<string, { brief_snapshot: Array<{ id: string; title: string; score?: number }>; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number } }>>({});
  const [kbNotes, setKbNotes] = useState<KbNoteRow[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const m = await getMetrics(pid);
        const map: Record<string, { brief_snapshot: Array<{ id: string; title: string; score?: number }>; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number } }> = {};
        m.forEach((r) => {
          if (r.task_id) {
            map[r.task_id] = {
              brief_snapshot: r.brief_snapshot ?? [],
              // Token usage persisted in metrics: backfills the cost block when there is no live WS usage (historical sessions)
              usage: {
                inputTokens: r.in_tokens ?? 0,
                outputTokens: r.out_tokens ?? 0,
                cacheReadTokens: r.cache_tokens ?? 0,
                reasoningTokens: r.reason_tokens ?? 0,
              },
            };
          }
        });
        if (alive) setBriefRows(map);
      } catch { /* a failed snapshot load has no effect */ }
      try {
        const r = await fetch(`/api/kb/notes?project=${encodeURIComponent(pid)}`);
        const notes = (await r.json()) as KbNoteRow[];
        if (alive) setKbNotes(Array.isArray(notes) ? notes : []);
      } catch { /* a failed notes load has no effect */ }
    })();
    return () => { alive = false; };
  }, [pid, cardId]);

  const setTab = (t: DrawerTab) => {
    useUi.getState().setRoute({ tab: t });
    writeHash(pid, useUi.getState().view, cardId, t);
  };
  const close = () => {
    useUi.getState().closeDetail();
    writeHash(pid, useUi.getState().view, null, 'comments');
  };

  // ESC closes the drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const paneRef = useRef<HTMLDivElement>(null);
  const [cInput, setCInput] = useState('');

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [tab, task?.activities.length, execUsage, stream]);

  if (!card) return <aside id="drawer" />;
  const st = task ? effectiveStatus(task) : 'Pending';
  const locked = st === 'Running' || st === 'Waiting';
  const unmet = cardUnmet(card, allCards);   // §2.1 scheduling gate: waiting on upstream (also counts when the card has no executions)
  const comments = task?.comments || [];
  const online = conn === 'online';

  const jump = (cid: string) => {
    useUi.getState().setRoute({ openId: cid, tab: 'comments' });
    writeHash(pid, useUi.getState().view, cid, 'comments');
  };

  const fork = async () => {
    if (!online) { toast('Control actions are disabled while disconnected'); return; }
    const newSid = await useProjection.getState().forkExecution(cardId, sid || undefined);
    if (newSid) {
      toast('Forked a new execution generation (the original event stream is kept for diffing)');
      setSelSid(newSid);
    } else {
      toast('Fork failed, see the error banner');
    }
  };

  const calibrate = async () => {
    if (!online) { toast('Control actions are disabled while disconnected'); return; }
    const newSid = await useProjection.getState().calibrateCard(cardId);
    if (newSid) toast('Requirement calibration started: AI explores and proposes acceptance criteria → approve → written back automatically');
    else toast('Failed to start calibration, see the error banner');
  };

  const cancel = async () => {
    if (!online) { toast('Control actions are disabled while disconnected'); return; }
    const ok = await useProjection.getState().cancelTask(sid);
    toast(ok ? 'Stop sent (POST cancel)' : 'Stop failed');
  };

  const sendComment = async (text: string) => {
    const v = text.trim();
    if (!v) return;
    if (!online) { toast('Control actions are disabled while disconnected'); return; }
    setCInput('');
    const ok = await useProjection.getState().postComment(sid, v);
    if (ok) {
      toast('Comment sent · engine running');
      useProjection.getState().loadCard(cardId);
    } else {
      toast('Failed to send comment');
      setCInput(v);
    }
  };

  // Approval decision: find this task's approval in the approval queue and approve/reject it (releasing a Waiting goes through the queue, not a comment)
  const decideWaiting = async (outcome: 'approved' | 'rejected') => {
    if (!online) { toast('Control actions are disabled while disconnected'); return; }
    if (!task?.waiting) return;
    try {
      const approvals = await listApprovals(pid);
      const appr = approvals.find((a) => a.execution_id === sid && a.outcome === null);
      if (!appr) { toast('No pending approval found (it may already have been decided)'); return; }
      const ok = await decideApproval(appr.id, outcome, outcome === 'approved' ? 'Approved, continue' : 'Needs changes');
      toast(ok ? `${outcome === 'approved' ? 'Approved' : 'Rejected'} · decision delivered to the agent` : 'Decision failed');
      if (ok) useProjection.getState().loadCard(cardId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const renderPane = () => {
    if (tab === 'comments') return renderComments();
    if (tab === 'brief') {
      // Brief = the actual assembly snapshot (metrics.brief_snapshot: the KB hit list at execution start)
      const briefRow = briefRows[sid];
      const hits = briefRow?.brief_snapshot ?? [];
      return (
        <>
          <details className="rulebox" open>
            <summary>Assembly rules</summary>
            <div className="rule">Only 4 kinds of sources: task definition / parent-task conclusions / knowledge-base retrieval (with relevance) / live state fetched on demand.</div>
            <div className="rule">Live state is never cached; knowledge and citations carry a validity period and are checked first when stale; project conventions are reused long-term.</div>
            <div className="rule">On conflict: live state &gt; conclusions &gt; knowledge base; conflicts are recorded in the brief.</div>
            <div className="rule">The brief has a budget cap; comments are the highest-priority input and are never trimmed.</div>
          </details>
          {hits.length === 0 ? (
            <div className="ph-empty">No KB hit snapshot for this execution (no knowledge hits, or the execution predates snapshot recording)</div>
          ) : (
            <ContextCards
              chunks={hits.map((h) => {
                const note = kbNotes.find((x) => x.id === h.id);
                return {
                  id: h.id,
                  title: h.title,
                  content: note ? note.content.join('\n') : undefined,
                  chars: note ? note.content.reduce((s, l) => s + l.length, 0) : undefined,
                  sourceKind: note?.source.kind,
                  sourceRef: note?.source.ref,
                  score: h.score,
                };
              })}
              title="Assembled context"
              countLabel={`${hits.length} entries`}
            />
          )}
          <div className="budget">Budget 8k tokens · {hits.length} hits<div className="pipeline">Retrieval: bitemporal filter → dual-channel recall → fused re-ranking → threshold filter → into the brief</div></div>
        </>
      );
    }
    if (tab === 'artifact') {
      // Artifacts = conclusion cards linked to the card (KB notes with source_ref=cardId, captured after acceptance passes)
      const artifacts = kbNotes.filter((n) => n.source?.ref === cardId);
      return (
        <>
          {artifacts.length === 0 ? (
            <>
              <div className="ph-empty">No conclusion cards yet —— once an execution completes and passes acceptance, its conclusions are captured as knowledge-base entries (downstream work cites conclusion cards, not chat logs)</div>
              <div className="note">Artifacts = knowledge-base entries (conclusion cards). See all of them in the "Knowledge" view.</div>
            </>
          ) : (
            <div className="artifact-list">
              {artifacts.map((n) => (
                <div key={n.id} className="artifact-item">
                  <div className="artifact-title">{n.title}</div>
                  <div className="artifact-tags">
                    <span className="tag">{n.trust}</span>
                    <span className="tag">{n.source?.kind}</span>
                    {n.tags?.map((t) => <span key={t} className="tag">{t}</span>)}
                  </div>
                  {n.content?.length ? <div className="artifact-content">{n.content.slice(0, 6).join('\n')}</div> : null}
                  {n.summary ? <div className="artifact-summary">{n.summary}</div> : null}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    return task ? (
      <TrajectoryView task={task} stream={tab === 'trajectory' ? stream : undefined} usageOverride={briefRows[sid]?.usage} />
    ) : null;
  };

  const renderComments = () => {
    // Comments = the user's control channel (the server only folds user/message); the agent's execution process is in the "Trajectory" tab
    return (
      <>
        {locked ? (
          <div className="banner warn">Running / awaiting-confirmation cards are locked: comments are the only control channel; replying continues the task.</div>
        ) : null}
        {comments.length === 0 && (
          <div className="ph-empty">No comments yet · comments are your control channel (instructions / decisions / guidance)</div>
        )}
        {comments.map((c, i) => (
          <div key={i} className="cmsg user">
            <div className="avatar">You</div>
            <div className="cbody">
              <div className="cmeta">
                <span className="who">You</span>
                <span>{fmtTime(c.at)}</span>
              </div>
              <div className="cbub"><Markdown text={c.text ?? ''} /></div>
            </div>
          </div>
        ))}
        {comments.length > 0 ? (
          <div className="note">The agent's execution process and replies are in the "Trajectory" tab.</div>
        ) : null}
      </>
    );
  };

  // —— Trajectory (dsh model: grouped by turn · #N row records · offset time · tool durations) ——
  return (
    <aside id="drawer" className="open">
      <div className="drawer-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <h2 style={{ flex: 1, minWidth: 0 }}>{card.title || cardId.slice(0, 16)}</h2>
          <Button mini variant="ghost" onClick={() => openSession(pid, sid, useUi.getState().view, cardId)} title="Open the full-screen session (you can keep chatting)">↗ Open session</Button>
          <Button variant="icon" onClick={close} title="Close (Esc)" aria-label="Close">
            <Icon name="x" size="sm" />
          </Button>
        </div>
        <div className="drawer-meta">
          <StatusPill status={st as TaskState['status']} />
          {card.milestone ? <span className="milestone-chip">{card.milestone}</span> : null}
          {task?.preset ? (
            <span className="preset-chip" title={`${MODE_LABEL[task.preset.mode as keyof typeof MODE_LABEL] ?? task.preset.mode} × ${SETTING_LABEL[task.preset.setting as keyof typeof SETTING_LABEL] ?? task.preset.setting} × ${APPROVAL_LABEL[task.preset.approval as keyof typeof APPROVAL_LABEL] ?? task.preset.approval} · sandbox ${SANDBOX_LABEL[task.preset.sandbox as keyof typeof SANDBOX_LABEL] ?? task.preset.sandbox}`}>
              📋 {task.preset.name}
            </span>
          ) : null}
          <span>{projects[pid]?.name ?? pid}</span>
          {task?.recovered ? <span className="rec" style={{ fontSize: 10, color: 'var(--text3)', border: '1px solid var(--line2)', borderRadius: 6, padding: '0 5px' }}>Recovered</span> : null}
          {task?.isolated ? <span title="Creating the task isolation area failed; this execution writes directly to the shared project directory" style={{ fontSize: 10, color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 6, padding: '0 5px' }}>⚠ Running in shared directory</span> : null}
          {unmet.length ? <span style={{ color: 'var(--yellow)' }}>Waiting on upstream: {unmet.join(', ')}</span> : null}
          {task?.worktree ? <span className="tag" title={task.worktree.path}>Isolated · {task.worktree.branch}</span> : null}
          {task?.waiting ? <span className="waiting-chip">⏸ Awaiting approval: {waitingLabel(task.waiting.kind)}</span> : null}
          {st === 'Running' ? <Button mini variant="ghost" onClick={cancel} disabled={!online}>⏹ Stop</Button> : null}
          <Button mini variant="ghost" onClick={fork} disabled={!online || unmet.length > 0} title={unmet.length ? 'Waiting on upstream: dependencies unfinished, cannot start' : 'Derive a new execution generation from the current execution (keeps the original event stream)'}>⑂ fork</Button>
          <Button mini variant="ghost" onClick={calibrate} disabled={!online} title="D1.7: AI explores and proposes acceptance criteria → you confirm → written back to the card's acceptance criteria automatically">🔬 Calibrate requirement</Button>
        </div>
      </div>

      {/* Acceptance criteria (requirement contract, D1.7): written back after calibration is confirmed; delivery-tier executions are accepted against it on completion */}
      {card.criteria ? (
        <div className="criteria-bar">
          <span className="criteria-label">Acceptance criteria</span>
          <code className="criteria-text">{card.criteria}</code>
        </div>
      ) : null}

      {/* Dependency contract (target contract: taskgraph): dependencies/dependents; click a chip to jump to that card */}
      {((task?.deps?.length ?? 0) > 0 || revDeps.length > 0) ? (
        <div className="drawer-deps">
          {(task?.deps?.length ?? 0) > 0 ? (
            <div className="dd-group">
              <span className="dd-label">Depends on · finish first</span>
              <div className="dd-chips">
                {task!.deps!.map((d) => {
                  const dc = allCards[d];
                  const dle = dc ? latestExecution(dc) : null;
                  return (
                    <button key={d} className="dd-chip" onClick={() => jump(d)} title={dc?.title || d}>
                      <StatusPill status={(dle ? effectiveStatus(dle) : 'Pending') as TaskState['status']} />
                      <span className="dd-title">{dc?.title || d.slice(0, 14)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {revDeps.length > 0 ? (
            <div className="dd-group">
              <span className="dd-label">Depended on by · waiting for this card</span>
              <div className="dd-chips">
                {revDeps.map((r) => (
                  <button key={r.id} className="dd-chip" onClick={() => jump(r.id)} title={r.title}>
                    <StatusPill status={r.status as TaskState['status']} />
                    <span className="dd-title">{r.title || r.id.slice(0, 14)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Waiting approval bar (§5 session drill-in): shown while the task is paused awaiting approval; decisions go through the approval queue */}
      {task?.waiting ? (
        <div className="approval-bar">
          <div className="appr-bar-info">
            <strong>⏸ Awaiting approval · {waitingLabel(task.waiting.kind)}</strong>
            <div className="muted">{task.waiting.reason || '(no reason given)'}</div>
            {task.waiting.payload?.plan ? (
              <details className="appr-plan" open>
                <summary>📋 Plan</summary>
                <div className="appr-plan-body"><Markdown text={task.waiting.payload.plan as string} /></div>
              </details>
            ) : null}
            {task.waiting.kind === 'acceptance' ? <AcceptanceEvidence payload={task.waiting.payload} /> : null}
          </div>
          <div className="appr-bar-actions">
            <Button mini variant="primary" onClick={() => void decideWaiting('approved')} disabled={!online}>✅ Approve and continue</Button>
            <Button mini onClick={() => void decideWaiting('rejected')} disabled={!online}>✋ Reject / needs changes</Button>
          </div>
        </div>
      ) : null}

      {/* Execution generation selector: the N in 1 card N executions (click to switch; the current generation is highlighted) */}
      {card.execution_count != null && card.execution_count > 1 || execs.length > 1 ? (
        <div className="exec-bar">
          <span className="exec-bar-label">Execution generations</span>
          {execs.map((e, i) => (
            <button
              key={e.id}
              className={'exec-chip' + (e.id === sid ? ' active' : '')}
              title={e.title || e.id}
              onClick={() => setSelSid(e.id)}
            >
              <span className={'dot ' + e.status} />Gen {i + 1}
              {e.status === 'Running' ? <span className="ellip" style={{ maxWidth: 60 }}> · running</span> : null}
            </button>
          ))}
          <Button mini variant="ghost" onClick={fork} disabled={!online || unmet.length > 0} title={unmet.length ? 'Waiting on upstream: dependencies unfinished, cannot start' : 'Derive a new execution from the current one'}>+ fork</Button>
        </div>
      ) : null}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} data-tab={t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="tabpane" ref={paneRef}>{renderPane()}</div>
      {tab === 'comments' ? (
        <div className="replybar">
          <textarea
            value={cInput}
            onChange={(e) => setCInput(e.target.value)}
            placeholder={locked ? 'Reply to the agent… (comments are control · replying continues)' : 'Reply to the agent…'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendComment(cInput);
              }
            }}
          />
          <div className="reply-actions">
            <Button mini onClick={() => void sendComment('Decision: approved, continue')} disabled={!online} title="Quick decision (steer semantics)">👍 Approve and continue</Button>
            <Button mini onClick={() => void sendComment('Decision: needs changes')} disabled={!online} title="Quick decision (steer semantics)">✋ Needs changes</Button>
            <span className="spacer" />
            <span className="kbd">Enter to send</span>
            <Button mini variant="primary" disabled={!cInput.trim() || !online} onClick={() => void sendComment(cInput)}>Send</Button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
