// Responsibility: standalone session drill-in page (O7: `#/p/:pid/t/:sid` full-screen DSH-style session) ——
//   chat view (collapsible thinking + tools + streaming + Prompt Bar control channel)
//   trajectory view (reuses the TrajectoryView timeline).
// Data: comments (user messages) + activities (agent activity stream) + usage (cost).
// Thinking/tools: grouped by turn into Thinking blocks (ported from Beautiful UI) —— reasoning + tools of the same turn are shown together.
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, effectiveStatus, waitingLabel, type TaskState } from '../store/projection';
import { listApprovals, decideApproval } from '../api/client';
import { Button } from '../components/Button';
import { TrajectoryView } from './TrajectoryView';
import { Markdown } from '../components/Markdown';
import { Thinking, type ThinkRow } from '../components/Thinking';
import { StreamingText } from '../components/StreamingText';
import { LoadingState } from '../components/LoadingState';
import { PromptBar, type PromptBarHandle, type SlashCommand } from '../components/PromptBar';
import { SelectionActions, promptFromSelection } from '../components/SelectionActions';

type SessionTab = 'chat' | 'trajectory';

/** Fold the activity stream into messages: user comments; text = agent body; think = one turn's reasoning + tools grouped together */
interface Msg {
  id: number;
  kind: 'user' | 'text' | 'think';
  text?: string;
  rows?: ThinkRow[];
  /** Timestamp (epoch ms, used for interleaved sorting) */
  at?: number;
}

export function SessionDetailView({ pid, sid }: { pid: string; sid: string }) {
  const cards = useProjection((s) => s.cards);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<SessionTab>('chat');
  const [input, setInput] = useState('');
  const [kbHits, setKbHits] = useState<{ id: string; title: string; summary: string }[]>([]);
  // In-session model switching (persisted per sid; the engine model plugin reads it via the shared file, effective next turn)
  const [selModel, setSelModel] = useState<string | null>(() => {
    try { return localStorage.getItem('helmsman-session-model:' + sid); } catch { return null; }
  });
  const pickModel = (m: string) => {
    try { localStorage.setItem('helmsman-session-model:' + sid, m); } catch { /* ignore */ }
    setSelModel(m);
    void fetch(`/api/sessions/${encodeURIComponent(sid)}/model`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
    toast(`Switched model to ${m} (takes effect next turn)`);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<PromptBarHandle>(null);

  // Reverse lookup of ownership: card execution → card.executions; simple chat → chats (group A)
  const cardEntry = Object.entries(cards[pid] ?? {}).find(([, c]) => c.executions[sid]);
  const card = cardEntry?.[1];
  const chats = useProjection((s) => s.chats[pid] || {});
  const task: TaskState | undefined = card?.executions[sid] ?? chats[sid];
  const stream = streams[sid];

  // Return to the view we came from (openSession keeps view in the URL; must not hard-code kanban)
  const back = () => {
    const from = useUi.getState().view;
    writeHash(pid, from === 'home' ? 'kanban' : from, card?.id ?? null, 'comments');
  };

  // Anchor to the bottom (chat view)
  useEffect(() => {
    if (tab === 'chat' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [task?.activities.length, task?.comments?.length, stream, tab]);

  const send = async (raw?: string) => {
    const v = (raw ?? input).trim();
    if (!v) return;
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    setInput('');
    const ok = await useProjection.getState().postComment(sid, v);
    if (ok) {
      toast('Sent · engine running');
      if (card) useProjection.getState().loadCard(card.id);
    } else {
      toast('Send failed');
      setInput(v);
    }
  };

  const searchKb = async (q: string) => {
    if (!q.trim()) { setKbHits([]); return; }
    try {
      const r = await fetch(`/api/kb/search?project=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      const rows = (await r.json()) as { id: string; title: string; summary: string }[];
      setKbHits(Array.isArray(rows) ? rows.slice(0, 8) : []);
    } catch { setKbHits([]); }
  };

  // Fold the message sequence: user comments first, then the agent activity stream (reasoning/tools grouped by turn, broken up by body text)
  const messages: Msg[] = (() => {
    const msgs: Msg[] = [];
    let n = 0;
    ((task?.comments) ?? []).forEach((c) => {
      if (c.who === 'user') msgs.push({ id: n++, kind: 'user', text: c.text, at: c.at ?? 0 });
    });
    // Tool-call argument index
    const toolById: Record<string, { args?: string; is_error?: boolean }> = {};
    (task?.tool_calls ?? []).forEach((tc) => { toolById[tc.call_id] = { args: tc.args, is_error: tc.is_error }; });

    let group: ThinkRow[] | null = null;
    const flush = () => {
      if (group && group.length) {
        msgs.push({ id: n++, kind: 'think', rows: group, at: group[0]?.at ?? 0 });
        group = null;
      }
    };

    const acts = task?.activities ?? [];
    let i = 0;
    while (i < acts.length) {
      const a = acts[i];
      if ('Reasoning' in a) {
        if (!group) group = [];
        group.push({ id: n++, kind: 'think', text: a.Reasoning.text, at: a.Reasoning.at ?? 0 });
        i++;
      } else if ('ToolStart' in a) {
        const row: ThinkRow = {
          id: n++,
          kind: 'tool',
          name: a.ToolStart.name,
          args: toolById[a.ToolStart.name]?.args ?? '',
          err: toolById[a.ToolStart.name]?.is_error ?? false,
          at: a.ToolStart.at ?? 0,
        };
        // Merge the immediately following ToolResult (duration / success)
        let j = i + 1;
        const next = j < acts.length ? acts[j] : null;
        if (next && 'ToolResult' in next) {
          const tr = next.ToolResult;
          const startAt = a.ToolStart.at;
          if (startAt != null && tr.at != null) row.ms = Math.max(0, tr.at - startAt);
          row.err = tr.is_error;
          j++;
        }
        if (!group) group = [];
        group.push(row);
        i = j;
      } else if ('Text' in a) {
        flush();
        msgs.push({ id: n++, kind: 'text', text: a.Text.text, at: a.Text.at ?? 0 });
        i++;
      } else {
        i++;
      }
    }
    flush();
    // Interleave by time (stable sort: the relative order of reasoning/tools/body within a turn is kept, user comments fall into place)
    return msgs.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  })();

  const st = task ? effectiveStatus(task) : 'Pending';
  const running = task?.status === 'Running';
  const copyOut = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => toast('Copied')).catch(() => toast('Copy failed'));
  };

  // Approval decision: goes through the formal approval API (queue release + decision record + policy capture), not a comment.
  // Same semantics as TaskDetailDrawer.decideWaiting (releasing a Waiting = going through the queue).
  const decideWaiting = async (outcome: 'approved' | 'rejected') => {
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    try {
      const approvals = await listApprovals(pid);
      const appr = approvals.find((a) => a.execution_id === sid && a.outcome === null);
      if (!appr) { toast('No pending approval found (it may already have been decided)'); return; }
      const ok = await decideApproval(appr.id, outcome, outcome === 'approved' ? 'Approved, continue' : 'Needs changes');
      toast(ok ? `${outcome === 'approved' ? 'Approved' : 'Rejected'} · decision delivered to the agent` : 'Decision failed');
      if (ok && card) useProjection.getState().loadCard(card.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const waitingFollow = task?.waiting ? [
    { id: 'approve', label: 'Approve and continue', onClick: () => { void decideWaiting('approved'); } },
    { id: 'revise', label: 'Needs changes', onClick: () => { void decideWaiting('rejected'); } },
  ] : undefined;
  const toolSources = messages
    .flatMap((x) => (x.kind === 'think' ? (x.rows ?? []) : []))
    .filter((r) => r.kind === 'tool' && r.name)
    .reduce<{ id: string; label: string }[]>((acc, r) => {
      const label = r.name as string;
      if (!acc.some((s) => s.label === label)) acc.push({ id: String(r.id), label });
      return acc;
    }, []);
  const commands: SlashCommand[] = [
    { id: 'approve', label: 'Approve and continue', hint: 'formal decision', run: () => { void decideWaiting('approved'); } },
    { id: 'revise', label: 'Needs changes', hint: 'formal decision', run: () => { void decideWaiting('rejected'); } },
  ];

  return (
    <div id="sessiondetail">
      <header className="sd-head">
        <Button variant="quiet" mini onClick={back} title="Back to the board">← Back</Button>
        <div className="sd-title">
          <strong>{card?.title ?? 'Session'}</strong>
          <span className="sd-meta">
            {st === 'Running' ? <span className="dot ok" /> : null}
            {st} · {task?.model ?? '-'} · turn {task?.turns ?? 0}
            {task?.waiting ? ` · ⏸ awaiting approval: ${waitingLabel(task.waiting.kind)}` : ''}
          </span>
        </div>
        <div className="sd-tabs">
          {(['chat', 'trajectory'] as SessionTab[]).map((t) => (
            <button key={t} className={'sd-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
              {t === 'chat' ? 'Chat' : 'Trajectory'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'chat' ? (
        <div className="sd-chat" ref={scrollRef}>
          <SelectionActions
            onAction={(kind, text) => {
              setInput(promptFromSelection(kind, text));
              barRef.current?.focus();
            }}
          >
            {messages.length === 0 && !stream && (
              <div className="ph-empty">
                {running ? <LoadingState variant="orbit" label="Engine thinking…" startedAt={task?.started_at} /> : 'No messages yet (the engine is running or has not started)'}
              </div>
            )}
            {messages.map((m, i) => {
              if (m.kind === 'user') {
                return (
                  <div key={m.id} className="sess-row user">
                    <div className="sess-bub user"><Markdown text={m.text ?? ''} /></div>
                  </div>
                );
              }
              if (m.kind === 'think') {
                return (
                  <div key={m.id} className="sess-row">
                    <Thinking rows={m.rows ?? []} running={running && i === messages.length - 1} />
                  </div>
                );
              }
              const last = i === messages.length - 1;
              return (
                <div key={m.id} className="sess-row">
                  <div className={'sess-bub md-bub' + ((m.text || '').indexOf('Failed') === 0 ? ' err' : '')}>
                    <Markdown text={m.text ?? ''} />
                    {last && !stream ? (
                      <StreamingText
                        copyValue={m.text}
                        onCopy={copyOut}
                        sources={toolSources}
                        followups={waitingFollow}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!stream && waitingFollow && messages.length > 0 && messages[messages.length - 1].kind !== 'text' ? (
              <div className="sess-row">
                <StreamingText followups={waitingFollow} />
              </div>
            ) : null}
            {stream ? (
              <div className="sess-row">
                <StreamingText text={stream} streaming markdown className="sess-stream" onCopy={copyOut} />
              </div>
            ) : null}
          </SelectionActions>
        </div>
      ) : (
        <div className="sd-traj">
          {task ? <TrajectoryView task={task} stream={stream} /> : <div className="ph-empty">Task not loaded</div>}
        </div>
      )}

      <footer className="sd-input">
        <PromptBar
          ref={barRef}
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          placeholder="Comments = control channel (instructions / guidance / decisions) · @ mention  / commands"
          disabled={conn !== 'online'}
          mentions={kbHits.map((h) => ({ id: h.id, title: h.title, sub: h.summary?.slice(0, 60) }))}
          onMentionQuery={(q) => void searchKb(q)}
          commands={commands}
          model={selModel || task?.model}
          onModelChange={pickModel}
        />
      </footer>
    </div>
  );
}
