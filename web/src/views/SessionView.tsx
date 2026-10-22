// Responsibility: simple chat (the loose entry point of the two-tier model, group A loop) —— zero-cost Q&A / exploration / research, kept off the board.
// Real engine: create a standalone ACP session (not attached to a card) → send messages → message stream = user comments + agent Text activities.
// Promote to task / save to knowledge base / @-cite knowledge-base search results —— the three main paths of the chat layer.
// Panel: Chat + Prompt Bar + Selection Actions (ported from Beautiful UI).
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, type TaskState } from '../store/projection';
import * as api from '../api/client';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import { ToolChips, type ToolChip } from '../components/ToolChips';
import { Thinking } from '../components/Thinking';
import { StreamingText } from '../components/StreamingText';
import { Markdown } from '../components/Markdown';
import { ChatPanel, type ChatTab } from '../components/ChatPanel';
import { PromptBar, type PromptBarHandle, type SlashCommand } from '../components/PromptBar';
import { SelectionActions, promptFromSelection } from '../components/SelectionActions';

interface KbHit { id: string; title: string; summary: string }

export function SessionView({ pid }: { pid: string }) {
  const chats = useProjection((s) => s.chats[pid] || {});
  const chatList = useProjection((s) => s.chatList[pid] || []);
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [sid, setSid] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedList, setArchivedList] = useState<api.ChatSummary[]>([]);
  // Currently active tab: chat sid / '__new__' (new chat) / '__archived__' (archived) —— decides the highlight
  const [activeTab, setActiveTab] = useState<string>('__new__');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [kbHits, setKbHits] = useState<KbHit[]>([]);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTitle, setPromoteTitle] = useState('');
  // In-chat model switching (persisted in localStorage; takes effect next turn when the engine model plugin reads it)
  const [selModel, setSelModel] = useState<string | null>(() => {
    try { return localStorage.getItem('helmsman-chat-model'); } catch { return null; }
  });
  const pickModel = (m: string) => {
    try { localStorage.setItem('helmsman-chat-model', m); } catch { /* ignore */ }
    setSelModel(m);
    // Write to the shared file (the engine model plugin reads it, effective next turn); requires the sid to exist
    if (sid) {
      void fetch(`/api/sessions/${encodeURIComponent(sid)}/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m }),
      }).catch(() => {});
    }
    toast(`Switched model to ${m} (takes effect next turn)`);
  };
  const areaRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<PromptBarHandle>(null);

  // On mount: reuse the latest chat (do not create one). No history → sid=null shows the empty state; a chat is only created when a message is sent.
  // The user switches to a past chat / clicks new chat → setSid.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await useProjection.getState().loadChats(pid);
      if (!alive) return;
      const list = useProjection.getState().chatList[pid] || [];
      if (list.length > 0) {
        // Reuse the latest chat (take the first by started_at descending)
        const latest = [...list].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
        setSid(latest.session_id);
        setActiveTab(latest.session_id);
        await useProjection.getState().loadChat(latest.session_id, pid);
      } else {
        setSid(null); // empty state: don't create, wait for the user to send a message
      }
    })();
    // Poll to refresh the current chat (rebinds when sid changes)
    const timer = setInterval(() => {
      const cur = useProjection.getState();
      if (cur.chatList[pid]?.length && alive) void cur.loadChats(pid);
    }, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [pid]);

  const task: TaskState | undefined = sid ? chats[sid] : undefined;
  const stream = useProjection((s) => (sid ? s.streams[sid] : undefined));

  // Anchor to the bottom
  useEffect(() => {
    if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }, [task?.activities.length, task?.comments?.length, stream]);

  const send = async () => {
    const v = input.trim();
    if (!v || busy) return;
    if (conn !== 'online') { toast('Control actions are disabled while disconnected'); return; }
    setBusy(true);
    setInput('');
    // Lazy creation: only actually create the chat when there is no sid (first message)
    let target = sid;
    if (!target) {
      target = await useProjection.getState().createChat(pid);
      if (!target) {
        setBusy(false);
        toast('Failed to create chat, see the error banner');
        return;
      }
      setSid(target);
      setActiveTab(target);
    }
    const ok = await useProjection.getState().sendChat(target, v);
    setBusy(false);
    if (!ok) toast('Send failed, see the error banner');
  };

  const searchKb = async (q: string) => {
    if (!q.trim()) { setKbHits([]); return; }
    try {
      const r = await fetch(`/api/kb/search?project=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      const rows = (await r.json()) as KbHit[];
      setKbHits(Array.isArray(rows) ? rows.slice(0, 8) : []);
    } catch { setKbHits([]); }
  };

  const promote = async () => {
    if (!sid) return;
    const cardId = await useProjection.getState().promoteChat(sid, { title: promoteTitle.trim() || undefined });
    if (cardId) {
      toast('Promoted to task: context goes into the brief, the engine runs it automatically');
      setPromoteOpen(false);
      writeHash(pid, 'kanban', cardId, 'comments');
      setSid(null);
      setActiveTab('__new__');
      setInput('');
    } else {
      toast('Promotion failed, see the error banner');
    }
  };

  const saveKb = async () => {
    if (!sid) return;
    const ok = await useProjection.getState().saveChatToKb(sid);
    toast(ok ? 'Saved to knowledge base (human-approved)' : 'Save failed, see the error banner');
  };

  const hasThread = !!task?.comments?.length;
  const commands: SlashCommand[] = [
    { id: 'promote', label: 'Promote to task', hint: 'to the board', run: () => { if (hasThread) setPromoteOpen(true); else toast('Chat a bit before promoting'); } },
    { id: 'save', label: 'Save to knowledge base', hint: 'human-approved', run: () => { if (hasThread) void saveKb(); else toast('Chat a bit before saving'); } },
  ];

  // Message sequence: user comments + agent thinking (Reasoning) + agent body (Text), interleaved by timestamp.
  // Order = the real conversation flow: input → thinking → output; never stack them in blocks (all comments / all thinking / all body).
  type Row = { kind: 'user' | 'think' | 'text'; text: string; at: number };
  const rows: Row[] = [
    ...(task?.comments || []).map((c) => ({ kind: c.who === 'user' ? ('user' as const) : ('text' as const), text: c.text, at: c.at ?? 0 })),
    ...(task?.activities || []).flatMap((a) => {
      if ('Reasoning' in a && a.Reasoning?.text) {
        return [{ kind: 'think' as const, text: a.Reasoning.text, at: a.Reasoning.at ?? 0 }];
      }
      if ('Text' in a && a.Text?.text) {
        return [{ kind: 'text' as const, text: a.Text.text, at: a.Text.at ?? 0 }];
      }
      return [];
    }),
  ].sort((a, b) => a.at - b.at);

  /** Render blocks: consecutive think rows are merged into one collapsible block (showing the thinking one row at a time is too fragmented) */
  const blocks: Array<
    | { kind: 'user'; text: string }
    | { kind: 'think'; texts: string[] }
    | { kind: 'text'; text: string }
  > = (() => {
    const out: Array<{ kind: 'user'; text: string } | { kind: 'think'; texts: string[] } | { kind: 'text'; text: string }> = [];
    for (const r of rows) {
      if (r.kind === 'user') { out.push({ kind: 'user', text: r.text }); continue; }
      if (r.kind === 'think') {
        const last = out[out.length - 1];
        if (last && last.kind === 'think') last.texts.push(r.text);
        else out.push({ kind: 'think', texts: [r.text] });
        continue;
      }
      out.push({ kind: 'text', text: r.text });
    }
    return out;
  })();

  // Tool-call summary (pair ToolStart with the immediately following ToolResult → collapsible chips)
  const toolCalls: ToolChip[] = (() => {
    const out: ToolChip[] = [];
    const acts = task?.activities ?? [];
    let i = 0;
    while (i < acts.length) {
      const a = acts[i];
      if ('ToolStart' in a) {
        const chip: ToolChip = { id: i, name: a.ToolStart.name, ok: true };
        let j = i + 1;
        const next = j < acts.length ? acts[j] : null;
        if (next && 'ToolResult' in next) {
          const tr = next.ToolResult;
          chip.ok = !tr.is_error;
          const sa = a.ToolStart.at;
          const ta = tr.at;
          if (sa != null && ta != null) chip.ms = Math.max(0, ta - sa);
          j++;
        }
        out.push(chip);
        i = j;
      } else {
        i++;
      }
    }
    return out;
  })();

  const offline = conn !== 'online';
  const copyOut = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => toast('Copied')).catch(() => toast('Copy failed'));
  };
  const sources = toolCalls.map((c) => ({ id: c.id, label: c.name }));
  const followups = hasThread ? [
    { id: 'promote', label: 'Promote to task', onClick: () => setPromoteOpen(true) },
    { id: 'save', label: 'Save to knowledge base', onClick: () => void saveKb() },
  ] : undefined;
  // Streaming display: only show the streaming area when stream exists and differs from the last Text in blocks.
  // Lifecycle: while streaming, stream accumulates (scrolling display); after turn/end REST backfills blocks,
  // and when the stream content == the last Text in blocks it yields naturally (no gap where content disappears and reappears).
  const lastText = blocks.length ? (() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'text') return blocks[i].text;
    }
    return '';
  })() : '';
  // Stream-yield check: stream is the in-progress version of lastText —— once blocks have been backfilled with the full text
  // (stream and lastText agree, ignoring an unfinished tail) the streaming area yields.
  // Rule: lastText starts with stream (stream is a prefix of the full text) and
  // stream already covers most of lastText (≥60%) → treat as backfilled, the stream yields.
  const lastLen = lastText.length;
  const streamLen = stream?.length ?? 0;
  const showStream = !!stream && !(lastLen > 0 && lastText.startsWith(stream) && streamLen >= lastLen * 0.6);
  // While streaming: the "text currently streaming" in blocks is shown by the streaming area, so drop it here to avoid duplication
  const visibleBlocks = showStream
    ? (() => {
        const out = [...blocks];
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].kind === 'text') { out.splice(i, 1); break; }
        }
        return out;
      })()
    : blocks;

  // Chat switcher: past-chat tabs (newest first) + new chat (label prefers the title, otherwise the last message)
  const sortedChats = [...chatList].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  const chatTabs: ChatTab[] = [
    ...sortedChats.slice(0, 8).map((c) => ({
      id: c.session_id,
      label: (c.title || c.last_text || 'Empty chat').slice(0, 14) + ((c.title || c.last_text || '').length > 14 ? '…' : ''),
      onRename: async (id, title) => {
        const ok = await useProjection.getState().renameChat(id, title);
        if (ok) await useProjection.getState().loadChats(pid);
      },
      onFork: async (id) => {
        const newSid = await useProjection.getState().forkChat(id, pid);
        if (newSid) {
          toast('Forked into a new chat');
          setSid(newSid);
          setActiveTab(newSid);
          await useProjection.getState().loadChats(pid);
        }
      },
      onArchive: async (id) => {
        const ok = await useProjection.getState().archiveChat(id, pid);
        if (ok) {
          toast('Chat archived');
          setSid(null);
          setActiveTab('__new__');
          await useProjection.getState().loadChats(pid);
        }
      },
    })),
    { id: '__new__', label: '+ New chat' },
    { id: '__archived__', label: '🗄 Archived' },
  ];

  const switchChat = async (id: string) => {
    setActiveTab(id);
    if (id === '__new__') {
      setSid(null); setArchivedOpen(false);
      setInput('');
      return;
    }
    if (id === '__archived__') {
      setSid(null); setArchivedOpen(true);
      try {
        const list = await api.listArchivedChats(pid);
        setArchivedList(Array.isArray(list) ? list : []);
      } catch { setArchivedList([]); }
      return;
    }
    setArchivedOpen(false);
    setSid(id);
    void useProjection.getState().loadChat(id, pid);
  };

  return (
    <div id="chatview">
      <ChatPanel
        tabs={chatTabs}
        tab={activeTab}
        onTab={switchChat}
        bodyRef={areaRef}
        footer={archivedOpen ? null : (
          <>
            <PromptBar
              ref={barRef}
              value={input}
              onChange={setInput}
              onSend={() => void send()}
              placeholder={sid ? "Continue this chat…  @ cite knowledge  / commands" : "Start a new chat: ask something…  @ cite knowledge  / commands"}
              disabled={offline}
              busy={busy}
              mentions={kbHits.map((h) => ({ id: h.id, title: h.title, sub: h.summary?.slice(0, 60) }))}
              onMentionQuery={(q) => void searchKb(q)}
              commands={commands}
              model={selModel || task?.model}
              onModelChange={pickModel}
              actions={(
                <>
                  <button type="button" className="pbar-tool" disabled={!hasThread} onClick={() => setPromoteOpen(true)} title="Promote to task">Promote</button>
                  <button type="button" className="pbar-tool" disabled={!hasThread} onClick={() => void saveKb()} title="Save to knowledge base">Save</button>
                </>
              )}
              extra={promoteOpen ? (
                <div className="kb-picker">
                  <div className="kb-picker-row">
                    <input value={promoteTitle} onChange={(e) => setPromoteTitle(e.target.value)} placeholder="Task title (defaults to the chat's first message)" />
                    <Button variant="primary" mini onClick={() => void promote()}>Confirm promotion</Button>
                    <Button variant="quiet" mini onClick={() => setPromoteOpen(false)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            />
          </>
        )}
      >
        <SelectionActions
          onAction={(kind, text) => {
            setInput(promptFromSelection(kind, text));
            barRef.current?.focus();
          }}
        >
          {archivedOpen ? (
            <div className="chat-archived">
              <div className="chat-archived-title">🗄 Archived chats</div>
              {archivedList.length === 0 ? (
                <div className="chat-empty">
                  <div className="d">No archived chats. Archived chats show up here and can be restored.</div>
                </div>
              ) : (
                <div className="chat-archived-list">
                  {archivedList.map((c) => (
                    <div key={c.session_id} className="chat-archived-item">
                      <span className="chat-archived-name">{c.title || c.session_id.slice(0, 14)}</span>
                      <span className="chat-archived-meta">{c.status} · {(c.started_at ? new Date(c.started_at).toLocaleString() : '')}</span>
                      <button
                        type="button"
                        className="chat-archived-restore"
                        onClick={async () => {
                          const ok = await api.restoreChat(c.session_id);
                          if (ok) {
                            toast('Chat restored');
                            setArchivedList((prev) => prev.filter((x) => x.session_id !== c.session_id));
                            await useProjection.getState().loadChats(pid);
                          } else toast('Restore failed, see the error banner');
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : !sid ? (
            <div className="chat-empty">
              <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
              <div className="t">New chat</div>
              <div className="d">Type your first message below to start (no chat is created until you send one). Q&amp;A and exploration stay off the board; once something takes shape you can promote it to a task, and anything worth remembering can be saved to the knowledge base.</div>
            </div>
          ) : blocks.length === 0 ? (
            <div className="chat-empty">
              <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
              <div className="d">Q&amp;A and exploration, kept off the board. Once something takes shape, promote it to a task; anything worth remembering, save it to the knowledge base.</div>
            </div>
          ) : (
            visibleBlocks.map((b, i) => (
              <div key={i} className={'chat-turn ' + (b.kind === 'user' ? 'user' : 'agent')}>
                {b.kind === 'think' ? (
                  <Thinking
                    rows={b.texts.map((text, j) => ({ id: i + '-' + j, kind: 'think', text }))}
                    running={busy || task?.status === 'Running'}
                  />
                ) : b.kind === 'user' ? (
                  <div className="chat-user"><Markdown text={b.text} /></div>
                ) : (
                  <div className="chat-agent">
                    <Markdown text={b.text} />
                    {i === visibleBlocks.length - 1 && !stream ? (
                      <StreamingText
                        copyValue={b.text}
                        onCopy={copyOut}
                        sources={sources}
                        followups={followups}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
          {toolCalls.length > 0 ? (
            <div className="chat-turn">
              <ToolChips calls={toolCalls} messages={blocks.filter((b) => b.kind === 'text').length} defaultOpen={task?.status === 'Running'} />
            </div>
          ) : null}
          {showStream ? (
            <div className="chat-turn">
              <StreamingText text={stream} streaming markdown sources={sources} onCopy={copyOut} />
            </div>
          ) : null}
        </SelectionActions>
      </ChatPanel>
    </div>
  );
}
