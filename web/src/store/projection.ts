// Responsibility: task projection store (zustand) + state derivation. The projection shape {pid:{cardId:CardState}} comes from the real REST API;
// M2.3 (O1=B): card = asset (1 card N executions), execution = session; board status = the latest execution generation.
// WS events are "change signals": they drive a debounced refetch (incremental catch-up via last_seq) and fold usage within the activeSession boundary.
// Red line 2: blocked (unfinished dependencies) is computed on every render (depsUnmet pure function), never written to a state field.
// Red line 4: cost / cache hit are computed from usage data, per session (usage accumulates from WS assistant/message; with no usage, show —).
import { create } from 'zustand';
import * as api from '../api/client';

// ---------- Real contract types (docs/frontend-design-v1.md §3.2; the service is the source of truth for shapes) ----------
export type TaskStatus = 'Pending' | 'Running' | 'Done' | 'Failed' | 'Cancelled';

/** WS /api/events event (mirror of dsh session-log events: {type,seq,time,data}; session events carry their own id) */
export interface WsEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Trajectory activity (server fold adds at = event time in ms, turn = owning turn; the time/turn dimensions of the dsh trajectory model) */
export type Activity =
  | { Text: { text: string; at?: number; turn?: number } }
  | { Reasoning: { text: string; at?: number; turn?: number } }
  | { ToolStart: { name: string; at?: number; turn?: number } }
  | { ToolResult: { name: string; is_error: boolean; at?: number; turn?: number } };

export interface ToolCall {
  call_id: string;
  name: string;
  args: string;
  is_error: boolean;
}

/** assistant/message.usage (real fields, shape observed in practice) */
export interface Usage {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Comment-thread entry (comments = the only control channel; produced by the server folding user/assistant messages) */
export interface Comment {
  who: 'user' | 'agent';
  text: string;
  at: number;                 // epoch ms
}

/** Execution = session (D1.2 1:1); TaskState is the execution unit of a board card (the N in 1 card N executions) */
export interface TaskState {
  id: string;                 // = dsh session id (opaque, the UI does not parse it)
  status: TaskStatus;
  title?: string;
  model?: string;
  turns: number;
  steps: number;
  tool_calls: ToolCall[];
  activities: Activity[];     // bounded queue (MAX_ACTIVITIES=200, server side)
  comments?: Comment[];       // comment thread (P0.5: already produced by the server)
  started_at?: number;
  finished_at?: number;
  last_seq: number;           // log seq folded so far (incremental sync watermark)
  recovered: boolean;         // flag: replayed from the session log after a service restart
  /** Waiting discriminated union (§2.5): non-null = the task is paused awaiting a decision */
  waiting?: { kind: 'plan' | 'permission' | 'acceptance' | 'cost' | 'calibrate' | 'checkpoint'; reason: string; payload: Record<string, unknown> } | null;
  /** Preset snapshot at execution start (§2.6: execution contract, carried through the task lifecycle) */
  preset?: { id: string; name: string; mode: string; setting: string; approval: string; sandbox: string } | null;
  /** Dependency contract snapshot (inherited from the card's deps; graph DAG edges = this field on the latest execution) */
  deps?: string[];
  /** Isolation area creation failed: this execution fell back to the shared project directory (M5) */
  isolated?: boolean;
  /** Task-level isolated workspace (git worktree) */
  worktree?: { path: string; branch: string } | null;
}

/** Waiting discriminated union (§2.5): non-null = the task is paused awaiting a decision */
export interface Waiting {
  kind: 'plan' | 'permission' | 'acceptance' | 'cost' | 'calibrate' | 'checkpoint';
  reason: string;
  payload: Record<string, unknown>;
}

/** Waiting kind display labels (shared by the approval queue / drawer / session page) */
export const WAITING_LABEL: Record<Waiting['kind'], string> = {
  plan: 'Plan review',
  calibrate: 'Acceptance criteria review',
  checkpoint: 'Checkpoint review',
  permission: 'Permission request',
  acceptance: 'Delivery acceptance',
  cost: 'Cost review',
};

export function waitingLabel(kind: string): string {
  return WAITING_LABEL[kind as Waiting['kind']] ?? kind;
}

/** Asset card (O1=B): card = requirement/defect/task + milestone, with executions attached (1 card N executions) */
export interface CardState {
  id: string;                 // card id (opaque)
  title: string;
  description?: string;
  kind?: string;              // 'requirement' | 'bug' | 'task'
  milestone?: string | null;
  deps?: string[];            // dependency contract: ids of cards that must be completed before this one
  criteria?: string | null;   // requirement contract: acceptance criteria (written back after D1.7 calibration is approved)
  executions: Record<string, TaskState>;  // sid → execution (key = session id)
  exec_order?: string[];      // execution generation order (creation order; last = latest)
  created_at?: number;
  execution_count?: number;
  project_id?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  card_count: number;
  /** Status counts [Pending, Running, Done, Failed, Cancelled] (by each card's latest execution status; for lightweight list rendering) */
  counts?: [number, number, number, number, number];
}

// ---------- Execution economics (P1.5 fix: DeepSeek V4 peak/off-peak pricing, effective 2026-08-17) ----------
/** CNY per million tokens; peak = Beijing time 9:00-12:00 ∪ 14:00-18:00 (everything else is off-peak; off-peak = half the peak price) */
export const PEAK_PRICE = {
  flash: { input: 3.0, output: 9.0, cacheRead: 0.1, reasoning: 9.0 },
  pro: { input: 9.0, output: 27.0, cacheRead: 0.3, reasoning: 27.0 },
} as const;
export const OFFPEAK_PRICE = {
  flash: { input: 1.5, output: 4.5, cacheRead: 0.05, reasoning: 4.5 },
  pro: { input: 4.5, output: 13.5, cacheRead: 0.15, reasoning: 13.5 },
} as const;

/** Beijing-time peak check (9:00-12:00 ∪ 14:00-18:00) */
export function isPeakHour(now = new Date()): boolean {
  const h = (now.getUTCHours() + 8) % 24;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** Price for the current period (flash by default; pro if model contains 'pro') */
export function priceOf(model?: string, now = new Date()) {
  const tier: 'flash' | 'pro' = model && model.toLowerCase().includes('pro') ? 'pro' : 'flash';
  return isPeakHour(now) ? PEAK_PRICE[tier] : OFFPEAK_PRICE[tier];
}

/** Estimated session cost (CNY, at the current period's price); no usage → null */
export function estCost(u?: Usage | null, model?: string): number | null {
  if (!u) return null;
  const p = priceOf(model);
  return (
    (u.inputTokens || 0) / 1e6 * p.input +
    (u.outputTokens || 0) / 1e6 * p.output +
    (u.cacheReadTokens || 0) / 1e6 * p.cacheRead +
    (u.reasoningTokens || 0) / 1e6 * p.reasoning
  );
}

/** Session cache hit rate = cacheRead / (cacheRead + input); no usage → null (spec §6.2 per-turn/per-session aggregation) */
export function cacheHitOf(u?: Usage | null): number | null {
  if (!u) return null;
  const denom = (u.cacheReadTokens || 0) + (u.inputTokens || 0);
  if (denom <= 0) return null;
  return u.cacheReadTokens / denom;
}

/** Average cache hit rate (across the current task set, aggregated per session); no data → null */
export function avgCacheHit(tasks: TaskState[], usage: Record<string, Usage>): number | null {
  const hits: number[] = [];
  tasks.forEach((t) => {
    const h = cacheHitOf(usage[t.id]);
    if (h != null) hits.push(h);
  });
  if (!hits.length) return null;
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

// ---------- State derivation (red line 2: always computed, never stored) ----------
/** Effective status = stored status (the real API has no Waiting; Waiting belongs to the target contract and flows in naturally once the service adds it) */
export function effectiveStatus(t: TaskState): TaskStatus | 'Waiting' {
  // Target contract: Waiting (awaiting confirmation) is the approval-seam state; task.waiting non-null = the task is paused awaiting a decision
  if (t.waiting) return 'Waiting';
  return t.status as TaskStatus | 'Waiting';
}

/** The card's latest execution (the display surface of 1 card N executions; exec_order first, falling back to key order) */
export function latestExecution(card: CardState | undefined | null): TaskState | null {
  if (!card) return null;
  const order = card.exec_order?.length ? card.exec_order : Object.keys(card.executions);
  const sid = order[order.length - 1];
  return (sid && card.executions[sid]) || null;
}

/** Card status = latest execution status (no execution = Pending) */
export function cardStatus(card: CardState | undefined | null): TaskStatus | 'Waiting' {
  const t = latestExecution(card);
  return t ? effectiveStatus(t) : 'Pending';
}

/** Execution generation list (by exec_order, defaulting to key order) */
export function executionList(card: CardState | undefined | null): TaskState[] {
  if (!card) return [];
  const order = card.exec_order?.length ? card.exec_order : Object.keys(card.executions);
  return order.map((sid) => card.executions[sid]).filter(Boolean);
}

/** Unfinished dependencies (target contract: taskgraph): computed on every render; returns the titles of unfinished dependencies. */
export function depsUnmet(t: TaskState, tasksById: Record<string, TaskState>): string[] {
  const deps = t.deps;
  if (!deps || !deps.length) return [];
  return deps
    .map((d) => tasksById[d])
    .filter((dep): dep is TaskState => !!dep && dep.status !== 'Done')
    .map((dep) => dep.title || dep.id);
}

/** Card-level unfinished dependencies (§2.1 scheduling gate "waiting on upstream"): also counts when the card has no executions (waiting on upstream = no execution generation).
 *  Returns the titles of unfinished dependencies; a missing dependency card also counts as unfinished. */
export function cardUnmet(card: CardState | undefined | null, cardsById: Record<string, CardState>): string[] {
  if (!card?.deps?.length) return [];
  return card.deps
    .map((d) => cardsById[d])
    .filter((dc) => {
      if (!dc) return true;
      const le = latestExecution(dc);
      return !le || effectiveStatus(le) !== 'Done';
    })
    .map((dc) => dc?.title || '(deleted)');
}

/** Activity summary text (used for a board card's last line / "happening now" on the home page) */
export function activityText(a: Activity): string {
  if ('Reasoning' in a) return a.Reasoning.text;
  if ('ToolStart' in a) return `Tool · ${a.ToolStart.name}`;
  if ('ToolResult' in a) return `Result · ${a.ToolResult.name} · ${a.ToolResult.is_error ? 'failed' : 'succeeded'}`;
  return a.Text.text;
}

export function statusCounts(tasks: TaskState[]): Record<TaskStatus | 'Waiting', number> {
  const c: Record<TaskStatus | 'Waiting', number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0, Waiting: 0 };
  tasks.forEach((t) => { c[effectiveStatus(t)] += 1; });
  return c;
}

export function fmtTime(ms?: number): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

export function relTime(ms?: number): string {
  if (ms == null) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export type ConnState = 'online' | 'reconnect' | 'offline';

/** Sessions whose reply has completed (marked by turn/end): late text-chunks are ignored to prevent streaming leftovers/duplicates. */
const doneTurns = new Set<string>();

interface ProjectionState {
  projects: Record<string, Project>;
  cards: Record<string, Record<string, CardState>>;  // pid → cardId → CardState (1 card N executions)
  /** Simple chats (group A): pid → sid → TaskState (standalone chats, not on the board) */
  chats: Record<string, Record<string, TaskState>>;
  /** Simple chat summary list (for the list view): pid → ChatSummary[] */
  chatList: Record<string, api.ChatSummary[]>;
  usage: Record<string, Usage>;                       // sid → session-level usage (accumulated from WS)
  /** sid → tail of the assistant/chunk streaming text (accumulated within the activeSession boundary; after a refetch the activities are complete, streaming is only shown while Running) */
  streams: Record<string, string>;
  loading: boolean;                                   // initial load
  error: string | null;
  conn: ConnState;
  maxEventSeq: number;                                // WS event seq watermark
  activeSessionId: string | null;                     // WS session event boundary (usage attribution)
  revision: number;                                   // +1 on any projection change (subscribed to by views / debounced refresh)
  loadProjects: () => Promise<void>;
  loadProject: (pid: string) => Promise<void>;
  loadCard: (cardId: string) => Promise<void>;
  loadTask: (sid: string) => Promise<void>;
  /** Simple chats (group A) */
  loadChats: (pid: string) => Promise<void>;
  loadChat: (sid: string, pid?: string) => Promise<void>;
  createChat: (pid: string) => Promise<string | null>;
  sendChat: (sid: string, text: string) => Promise<boolean>;
  renameChat: (sid: string, title: string) => Promise<boolean>;
  forkChat: (sid: string, pid?: string) => Promise<string | null>;
  archiveChat: (sid: string, pid?: string) => Promise<boolean>;
  promoteChat: (sid: string, input: { title?: string; description?: string }) => Promise<string | null>;
  saveChatToKb: (sid: string, title?: string) => Promise<boolean>;
  createCard: (pid: string, input: api.CreateCardInput) => Promise<string | null>;
  /** fork: derive a new execution generation on a card (from_execution_id optional); returns the new execution (session) id */
  forkExecution: (cardId: string, fromExecutionId?: string) => Promise<string | null>;
  /** D1.7 requirement calibration: AI explores and proposes acceptance criteria → confirm → write back criteria; returns the calibration session id */
  calibrateCard: (cardId: string) => Promise<string | null>;
  /** Mark status manually (drag / manually mark done / failed / to-do) */
  markCardStatus: (cardId: string, status: 'Done' | 'Failed' | 'Pending') => Promise<boolean>;
  cancelTask: (sid: string) => Promise<boolean>;
  postComment: (sid: string, text: string) => Promise<boolean>;
  /** Register a project explicitly (POST /api/projects) → refresh the project list → return the registration result */
  registerProject: (path: string, name?: string) => Promise<Project | null>;
  /** Remove a project (archive = recoverable removal / purge = full cleanup); returns whether it succeeded */
  removeProject: (pid: string, mode: 'archive' | 'purge') => Promise<boolean>;
  applyWsEvent: (ev: WsEvent) => void;
  setConn: (s: ConnState) => void;
  bump: () => void;
}

export const useProjection = create<ProjectionState>((set, get) => ({
  projects: {},
  cards: {},
  chats: {},
  chatList: {},
  usage: {},
  streams: {},
  loading: true,
  error: null,
  conn: 'offline',
  maxEventSeq: 0,
  activeSessionId: null,
  revision: 0,

  loadProjects: async () => {
    try {
      const ps = await api.listProjects();
      set((s) => {
        const projects = { ...s.projects };
        ps.forEach((p) => { projects[p.id] = p; });
        return { projects, loading: false, error: null };
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadProject: async (pid) => {
    try {
      const p = await api.getProject(pid);
      set((s) => {
        const cards = { ...s.cards, [pid]: p.cards };
        const projects = { ...s.projects, [pid]: { id: p.id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length } };
        return { cards, projects, error: null };
      });
      // Group A: also load the simple chats (full TaskState)
      try {
        const list = await api.listChats(pid);
        const full: Record<string, TaskState> = {};
        await Promise.all(list.map(async (c) => {
          try { full[c.session_id] = await api.getChat(c.session_id); } catch { /* skip a single failure */ }
        }));
        set((s) => ({ chats: { ...s.chats, [pid]: full }, chatList: { ...s.chatList, [pid]: list } }));
      } catch { /* a failed chat list does not block loading the cards */ }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadCard: async (cardId) => {
    try {
      const c = await api.getCard(cardId);
      set((s) => {
        const pid = c.project_id || Object.keys(s.cards).find((k) => s.cards[k][cardId]);
        if (!pid) return { error: `card ${cardId}: owning project unknown` };
        return { cards: { ...s.cards, [pid]: { ...s.cards[pid], [cardId]: c } } };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadChats: async (pid) => {
    try {
      const list = await api.listChats(pid);
      set((s) => ({ chatList: { ...s.chatList, [pid]: list } }));
    } catch { /* a failed list does not block anything */ }
  },

  loadChat: async (sid, pid) => {
    try {
      const t = await api.getChat(sid);
      set((s) => {
        // Ownership: prefer the explicit pid, otherwise look it up from existing entries
        const pid2 = pid || Object.keys(s.chats).find((k) => s.chats[k][sid]);
        if (!pid2) return { error: 'chat: owning project unknown' };
        return { chats: { ...s.chats, [pid2]: { ...s.chats[pid2], [sid]: t } } };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  createChat: async (pid) => {
    try {
      const r = await api.createChat(pid);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadChats(pid);
      return r.session_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  sendChat: async (sid, text) => {
    try {
      // Pin the streaming owner explicitly: the WS session event only updates activeSessionId when a session is created,
      // so consecutive sends in the same chat would reuse a stale value → streaming text attached to the wrong chat. Pin it to the current sid before sending.
      set({ activeSessionId: sid });
      // A new round starts: clear the previous round's done marker (this chat's text-chunks take effect again)
      doneTurns.delete(sid);
      await api.sendChat(sid, text);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadChat(sid);
      // Streaming done + REST backfill done → clear this chat's stream (same tick as the blocks update: no gap, no duplication)
      set((s) => {
        if (!s.streams[sid]) return {};
        const streams = { ...s.streams };
        delete streams[sid];
        return { streams };
      });
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  renameChat: async (sid, title) => {
    try {
      const ok = await api.renameChat(sid, title);
      if (ok) {
        set((s) => ({ revision: s.revision + 1 }));
        await get().loadChat(sid);
      }
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  forkChat: async (sid, pid) => {
    try {
      const r = await api.forkChat(sid);
      if (!r.session_id) return null;
      set((s) => ({ revision: s.revision + 1 }));
      if (pid) await get().loadChats(pid);
      return r.session_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  archiveChat: async (sid, pid) => {
    try {
      const ok = await api.archiveChat(sid);
      if (ok) {
        set((s) => ({ revision: s.revision + 1 }));
        if (pid) await get().loadChats(pid);
      }
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  promoteChat: async (sid, input) => {
    try {
      const r = await api.promoteChat(sid, input);
      set((s) => ({ revision: s.revision + 1 }));
      // The chat became a card: refresh the project (card list) + clear the chat summary
      const pid = Object.keys(get().chatList).find((k) => get().chats[k]?.[sid]);
      await get().loadProject(pid || 'helmsman');
      return r.card_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  saveChatToKb: async (sid, title) => {
    try {
      await api.saveChatToKb(sid, title);
      set((s) => ({ revision: s.revision + 1 }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  loadTask: async (sid) => {
    try {
      const t = await api.getTask(sid);
      set((s) => {
        // Look up the owning card by sid (scan executions in the cards dictionary)
        for (const pid of Object.keys(s.cards)) {
          for (const cardId of Object.keys(s.cards[pid])) {
            if (s.cards[pid][cardId].executions[sid]) {
              return {
                cards: {
                  ...s.cards,
                  [pid]: {
                    ...s.cards[pid],
                    [cardId]: { ...s.cards[pid][cardId], executions: { ...s.cards[pid][cardId].executions, [sid]: t } },
                  },
                },
              };
            }
          }
        }
        return {};
      });
    } catch { /* a failed single-task fetch does not block the rest */ }
  },

  createCard: async (pid, input) => {
    try {
      const r = await api.createCard(pid, input);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadProject(pid);
      return r.card_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  forkExecution: async (cardId, fromExecutionId) => {
    try {
      const r = await api.forkExecution(cardId, fromExecutionId);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadCard(cardId);
      return r.session_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  calibrateCard: async (cardId) => {
    try {
      const r = await api.calibrateCard(cardId);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadCard(cardId);
      return r.session_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  markCardStatus: async (cardId, status) => {
    try {
      const ok = await api.markStatus(cardId, status);
      if (ok) {
        set((s) => ({ revision: s.revision + 1 }));
        await get().loadCard(cardId);
      }
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  cancelTask: async (sid) => {
    try {
      const ok = await api.cancelTask(sid);
      if (ok) set((s) => ({ revision: s.revision + 1 }));
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  postComment: async (sid, text) => {
    try {
      const ok = await api.postComment(sid, text);
      if (ok) set((s) => ({ revision: s.revision + 1 }));
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  registerProject: async (path, name) => {
    try {
      const p = await api.createProject(path, name);
      set((s) => ({ projects: { ...s.projects, [p.id]: p }, error: null }));
      await get().loadProjects();
      return p;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  removeProject: async (pid, mode) => {
    try {
      const ok = await api.removeProject(pid, mode);
      if (ok) {
        set((s) => {
          const projects = { ...s.projects };
          delete projects[pid];
          const cards = { ...s.cards };
          delete cards[pid];
          return { projects, cards, revision: s.revision + 1 };
        });
        await get().loadProjects();
      }
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  // WS event folding (lightweight): session events mark the boundary; assistant/message folds usage; everything else only raises the watermark.
  // The projection itself is defined by the REST refetch (the service fold is authoritative); events only decide "when to refresh".
  applyWsEvent: (ev) => {
    const patch: Partial<ProjectionState> = {};
    if (ev.type === 'session' && (ev as WsEvent & { id?: string }).id) {
      patch.activeSessionId = (ev as WsEvent & { id: string }).id;
      // New executions (sessions) enter the projection via the server fold + debounced refetch (card id unknown, so no local placeholder).
    }
    if (ev.type === 'assistant/chunk') {
      const c = ev.data?.chunk as { type?: string; text?: string } | undefined;
      if (c?.type === 'text-delta' && c.text) {
        const sid = get().activeSessionId;
        if (sid) {
          patch.streams = { ...get().streams, [sid]: (get().streams[sid] || '') + c.text };
        }
      }
    }
    // Incremental streaming body: dsh actually pushes text-chunks (data.texts segment by segment), not assistant/chunk text-delta.
    // This is the only place that gives the "shows up as it types" effect. Late chunks for sessions whose reply has completed (after turn/end) are ignored.
    if (ev.type === 'text-chunks') {
      const texts = (ev.data?.texts as string[] | undefined) ?? [];
      const sid = get().activeSessionId;
      if (sid && texts.length > 0 && !doneTurns.has(sid)) {
        patch.streams = { ...get().streams, [sid]: (get().streams[sid] || '') + texts.join('') };
      }
    }
    // turn/end = this round's reply is complete. Only mark it (to stop late chunks from being appended), don't clear the stream ——
    // clearing too early creates a "content disappears then reappears" flicker before the REST backfill of blocks;
    // SessionView's showStream equality check (stream === the last Text in blocks) makes it yield instead.
    if (ev.type === 'turn/end') {
      const sid = get().activeSessionId;
      if (sid) doneTurns.add(sid);
    }
    if (ev.type === 'assistant/message' && ev.data?.usage) {
      const u = ev.data.usage as Usage;
      // Note: don't clear the stream on assistant/message (it would flash at the end) ——
      // SessionView's showStream equality check takes over: once REST backfills the full message, the stream yields naturally.
      if (u.inputTokens || u.outputTokens || u.cacheReadTokens || u.reasoningTokens) {
        const sid = get().activeSessionId;
        if (sid) {
          const prev = get().usage[sid] || { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
          patch.usage = {
            ...get().usage,
            [sid]: {
              cacheReadTokens: (prev.cacheReadTokens || 0) + (u.cacheReadTokens || 0),
              inputTokens: (prev.inputTokens || 0) + (u.inputTokens || 0),
              outputTokens: (prev.outputTokens || 0) + (u.outputTokens || 0),
              reasoningTokens: (prev.reasoningTokens || 0) + (u.reasoningTokens || 0),
            },
          };
        }
      }
    }
    if (typeof ev.seq === 'number' && ev.seq > get().maxEventSeq) {
      patch.maxEventSeq = ev.seq;
    }
    patch.revision = get().revision + 1;
    set(patch);
  },

  setConn: (s) => set({ conn: s }),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** Sync targets: the data the current view needs to fetch (pid and openId come from the UI store; called after debouncing).
 *  Projects pending registration (local pending) return 404 from the server, so fetching is skipped; the service registers them after the first card is POSTed. */
export function refreshTargets(pid: string | null, openId: string | null, home: boolean) {
  const p = useProjection.getState();
  if (home || !pid) {
    p.loadProjects();
    return;
  }
  const { pendingProjects } = useUiStoreRef.getState();
  if (!pendingProjects[pid]) p.loadProject(pid);
  if (openId) p.loadCard(openId);
}

// Deferred reference to avoid a circular import (the ui store references projection's types)
import { useUi as useUiStoreRef } from './ui';