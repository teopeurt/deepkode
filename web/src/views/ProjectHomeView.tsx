// Responsibility: project home page —— status badge group (by each card's latest execution status) + needs your attention (failed / awaiting-confirmation target contract)
// + happening now (running) + recent captures (knowledge-base target contract) + actions (new card / simple chat / run all) + project settings (target contract, read-only).
// M2.3 (O1=B): the project aggregates by card; a board card = an asset card (1 card N executions, status = latest execution).
import { useEffect, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import {
  useProjection, cardStatus, latestExecution, activityText,
  type CardState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import { TaskRows, type TaskRowItem } from '../components/TaskRows';
import { RemoveProjectModal } from '../components/modals/RemoveProjectModal';
import { ContextCards, type ContextChunk } from '../components/ContextCards';
import { listKbNotes, listApprovals, type KbNoteRow } from '../api/client';

export function ProjectHomeView({ pid }: { pid: string }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [kbRecent, setKbRecent] = useState<KbNoteRow[]>([]);
  const [repo, setRepo] = useState<{
    branch: string; dirty: number; staged: number; untracked: number; conflicted: number;
    ahead: number; behind: number; lastCommit: string; error?: string;
    changes: Array<{ code: string; staged: boolean; path: string }>;
    branches: Array<{ name: string; current: boolean }>;
    history: Array<{ hash: string; when: string; subject: string }>;
  } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const project = useProjection((s) => s.projects[pid]);
  const pending = useUi((s) => s.pendingProjects[pid]);
  const cards = useProjection((s) => s.cards[pid] || {});
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);
  const toast = useUi((s) => s.toast);

  const clist = Object.values(cards);
  const counts: Record<string, number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0 };
  clist.forEach((c) => { counts[cardStatus(c)] += 1; });
  const failed = clist.filter((c) => cardStatus(c) === 'Failed');
  const running = clist.filter((c) => cardStatus(c) === 'Running');
  const isPending = !project && !!pending;
  const name = project?.name ?? pending?.name ?? pid;
  const path = project?.path ?? pending?.path ?? '';

  const goView = (view: 'kanban' | 'chat' | 'graph' | 'kb' | 'files') => {
    useUi.getState().setRoute({ view, openId: null, tab: 'comments' });
    writeHash(pid, view, null, 'comments');
  };

  // Real implementations wired in: recent captures (KB) / live repo status (top level of the file tree) / pending approval count
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [notes, approvals] = await Promise.all([listKbNotes(pid), listApprovals(pid)]);
        if (!alive) return;
        setKbRecent(notes.filter((n) => n.validUntil === null).sort((a, b) => b.validFrom - a.validFrom).slice(0, 4));
        setPendingCount(approvals.length);
      } catch { /* home-page data failures do not block */ }
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/repo-status`);
        if (r.ok) {
          const rs = (await r.json()) as typeof repo;
          if (alive) setRepo(rs);
        }
      } catch { /* repo status failures are ignored */ }
    })();
    return () => { alive = false; };
  }, [pid]);

  const lastText = (c: CardState): string => {
    const e = latestExecution(c);
    if (e && e.activities.length) return activityText(e.activities[e.activities.length - 1]).slice(0, 24);
    return '';
  };

  return (
    <div id="projhome">
      {isPending ? (
        <div className="banner warn" style={{ marginBottom: 18 }}>
          New project pending registration (offline fallback): you can create the first card (POST /api/projects/:pid/cards), or reopen "New project" to register it explicitly.
        </div>
      ) : null}
      <div className="ph-head">
        <h1>{name}</h1>
        <div className="ph-path">{path || '—'}</div>
        <div className="ph-status">
          {(['Running', 'Failed', 'Pending', 'Done', 'Cancelled'] as const)
            .filter((k) => counts[k] > 0)
            .map((k) => <StatusPill key={k} status={k} label={(k === 'Running' ? 'Running ' : k === 'Failed' ? 'Failed ' : k === 'Pending' ? 'To do ' : k === 'Done' ? 'Done ' : 'Cancelled ') + counts[k]} />)}
          <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>· {clist.length} cards</span>
        </div>
      </div>

      <div className="ph-cols">
        <div className="ph-col">
          <div className="ph-sec">
            <div className="ph-sec-t">Needs your attention</div>
            {failed.length ? (
              <TaskRows
                items={failed.map<TaskRowItem>((c) => {
                  const e = latestExecution(c);
                  return {
                    id: c.id,
                    title: c.title || c.id.slice(0, 12),
                    status: 'failed',
                    meta: `Executions ×${c.execution_count ?? Object.keys(c.executions).length}`,
                    detail: e && e.activities.length
                      ? [{ label: 'Last activity', value: activityText(e.activities[e.activities.length - 1]).slice(0, 60) }]
                      : undefined,
                    onClick: () => openDetail(pid, c.id, 'comments'),
                  };
                })}
              />
            ) : <div className="ph-empty">No tasks need your attention</div>}
            <div className="ph-hint2">{pendingCount > 0 ? `${pendingCount} pending approvals · see the approval queue` : 'No pending approvals'}</div>
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">Happening now</div>
            {running.length ? (
              <TaskRows
                items={running.map<TaskRowItem>((c) => {
                  const e = latestExecution(c);
                  return {
                    id: c.id,
                    title: c.title || c.id.slice(0, 12),
                    status: 'running',
                    progress: e?.steps ?? e?.turns,
                    meta: lastText(c),
                    onClick: () => openDetail(pid, c.id, 'comments'),
                  };
                })}
              />
            ) : <div className="ph-empty">No tasks are running</div>}
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">Repository</div>
            {repo === null ? (
              <div className="ph-empty">Loading repository status…</div>
            ) : repo.error ? (
              <div className="ph-empty">{repo.error === 'not a git repo' ? 'Not a git repository' : 'Repository status unreadable'}</div>
            ) : (
              <div className="repo-status">
                <div className="repo-row">
                  <span className="tag">Branch</span>
                  <b className="repo-branch">{repo.branch || '(no branch)'}</b>
                  {(repo.ahead > 0 || repo.behind > 0) ? (
                    <span className="repo-sync" title="Compared with remote">{repo.ahead > 0 ? `↑${repo.ahead}` : ''}{repo.ahead > 0 && repo.behind > 0 ? ' ' : ''}{repo.behind > 0 ? `↓${repo.behind}` : ''}</span>
                  ) : null}
                  {repo.conflicted > 0 ? (
                    <span className="repo-conflict">{repo.conflicted} conflicts</span>
                  ) : repo.dirty > 0 ? (
                    <span className={'repo-dirty' + (repo.staged > 0 ? ' staged' : '')}>
                      {repo.dirty} changes
                      {repo.staged > 0 ? ` · ${repo.staged} staged` : ''}
                      {repo.untracked > 0 ? ` · ${repo.untracked} new files` : ''}
                    </span>
                  ) : (
                    <span className="repo-clean">Working tree clean</span>
                  )}
                </div>
                {repo.changes.length > 0 ? (
                  <div className="repo-sec">
                    <div className="repo-sec-t">Changes</div>
                    {repo.changes.map((c) => (
                      <div key={c.path} className="repo-change">
                        <span className={'repo-code ' + codeCls(c.code)} title={codeLabel(c.code)}>{c.code}</span>
                        <span className="repo-path">{c.path}</span>
                        {c.staged ? <span className="repo-staged-tag">staged</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {repo.branches.length > 0 ? (
                  <div className="repo-sec">
                    <div className="repo-sec-t">Branches</div>
                    {repo.branches.map((b) => (
                      <div key={b.name} className={'repo-branch-item' + (b.current ? ' cur' : '')}>
                        <span className="repo-dot">{b.current ? '●' : '○'}</span>
                        <span className="repo-bname">{b.name}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {repo.history.length > 0 ? (
                  <div className="repo-sec">
                    <div className="repo-sec-t">Commits</div>
                    {repo.history.map((h) => (
                      <div key={h.hash} className="repo-commit" title={h.subject}>
                        <span className="repo-hash">{h.hash}</span>
                        <span className="repo-subject">{h.subject}</span>
                        <span className="repo-when">{h.when}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="ph-col">
          <div className="ph-sec">
            <div className="ph-sec-t">Recent captures</div>
            {kbRecent.length ? (
              <ContextCards
                chunks={kbRecent.map<ContextChunk>((n) => ({
                  id: n.id,
                  title: n.title,
                  content: n.content.slice(0, 2).join('\n'),
                  chars: n.content.reduce((acc, l) => acc + l.length, 0),
                  onClick: () => goView('kb'),
                  sourceKind: n.source.kind,
                  sourceRef: n.source.ref,
                  badges: [{ label: n.trust === 'human-approved' ? 'Human-confirmed' : n.trust === 'agent-generated' ? 'Auto-captured' : 'Unverified', tone: n.trust === 'human-approved' ? 'ok' : n.trust === 'agent-generated' ? 'info' : 'muted' }],
                }))}
                showHead={false}
                empty=""
              />
            ) : <div className="ph-empty">The knowledge base is empty —— conclusions are captured here automatically when tasks complete</div>}
            <div className="ph-hint2">Recently captured conclusions · click to open the knowledge base</div>
          </div>
          <div className="ph-sec">
            <div className="ph-sec-t">Actions</div>
            <div className="ph-actions">
              <Button onClick={() => setNewTaskOpen(true)}><Icon name="plus" size="sm" />New card</Button>
              <Button onClick={() => goView('chat')}><Icon name="chat" size="sm" />Simple chat</Button>
              <Button variant="primary" onClick={() => { toast('A new card runs its first generation automatically; to start another execution generation, fork from the card detail'); useProjection.getState().bump(); }}>
                <Icon name="play" size="sm" />Run all
              </Button>
              <Button variant="ghost" onClick={() => setRemoveOpen(true)} style={{ color: 'var(--text3)' }}>
                Remove project
              </Button>
            </div>
          </div>
          {removeOpen ? <RemoveProjectModal pid={pid} name={name} onClose={() => setRemoveOpen(false)} /> : null}
        </div>
      </div>

      <details className="settings">
        <summary>Project settings</summary>
        <div className="row"><span>Model tiering</span><span className="dim">auto (flash-first · target contract)</span></div>
        <div className="row"><span>Retrieval threshold</span><span className="dim">0.55 (target contract)</span></div>
        <div className="row"><span>Brief budget</span><span className="dim">8k tokens (target contract)</span></div>
        <div className="row"><span>Concurrency limit</span><span className="dim">2 (target contract)</span></div>
        <div className="row"><span>Credentials</span><span className="dim">DEEPSEEK_API_KEY (env)</span></div>
        <div className="row"><span>Project instructions</span><span className="dim">AGENTS.md (target contract)</span></div>
      </details>
    </div>
  );
}

/** Change status letter → color class (VSCode source-control colors) */
function codeCls(code: string): string {
  if (code === 'A') return 'add'
  if (code === 'D') return 'del'
  if (code === 'M' || code === 'R' || code === 'C') return 'mod'
  if (code === '?') return 'new'
  if (code === 'U') return 'conf'
  return ''
}
function codeLabel(code: string): string {
  const m: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Untracked', U: 'Conflict' }
  return m[code] ?? code
}

// Open the drawer (reused across views; openId = card id, the execution generation is chosen inside the drawer)
function openDetail(pid: string, cardId: string, tab: 'comments' | 'brief' | 'artifact' | 'trajectory') {
  useUi.getState().setRoute({ pid, openId: cardId, tab });
  writeHash(pid, useUi.getState().view, cardId, tab);
}