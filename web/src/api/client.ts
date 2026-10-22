// Responsibility: REST wrapper —— real endpoints (contract in docs/frontend-design-v1.md §3.1; the service is the source of truth for shapes).
// M2.3: two-layer asset cards —— the card (O1=B, 1 card N executions) is the main resource; execution = session (operated on by sid).
// Goes through the Vite dev proxy (/api → 127.0.0.1:3081; the service sends no CORS headers, so a same-origin proxy is required).
import type { Project, TaskState } from '../store/projection';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body.slice(0, 200);
    } catch { /* ignore */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

/** GET /api/projects —— project list [{id,name,path,card_count,counts}] */
export function listProjects(): Promise<Project[]> {
  return req<Project[]>('/projects');
}

/** GET /api/projects/:pid —— project detail {id,name,path,cards:{<cardId>:CardState}} (cards is a dictionary) */
export async function getProject(pid: string): Promise<{ id: string; name: string; path: string; cards: Record<string, CardState> }> {
  return req('/projects/' + encodeURIComponent(pid));
}

/** GET /api/projects/:pid/cards —— card list (lightweight: latest execution status + milestone + execution count) */
export interface CardSummary {
  id: string;
  title: string;
  description: string;
  kind: string;
  milestone?: string | null;
  execution_count: number;
  created_at?: number;
  latest?: {
    session_id: string;
    status: string;
    title?: string | null;
    started_at?: number | null;
    finished_at?: number | null;
  } | null;
}
export function listCards(pid: string): Promise<CardSummary[]> {
  return req<CardSummary[]>('/projects/' + encodeURIComponent(pid) + '/cards');
}

/** GET /api/cards/:cardId —— card detail (all execution generations; executions dictionary key = session id) */
export interface CardDetail {
  id: string;
  title: string;
  description: string;
  kind: string;
  milestone?: string | null;
  deps?: string[];          // dependency contract: ids of cards that must be completed before this one
  criteria?: string | null; // requirement contract: acceptance criteria (written back after D1.7 calibration is approved)
  created_at?: number;
  execution_count: number;
  project_id?: string;
  executions: Record<string, TaskState>;
  exec_order?: string[];
}
export function getCard(cardId: string): Promise<CardDetail> {
  return req<CardDetail>('/cards/' + encodeURIComponent(cardId));
}

/** POST /api/projects/:pid/cards —— create a card (asset) + first-generation execution (a new card runs automatically); 201 {card_id, session_id} */
export interface CreateCardInput {
  title: string;
  description?: string;
  kind?: string; // 'requirement' | 'bug' | 'task'
  milestone?: string;
  preset?: string; // agent preset id (per-task tool/persona assembly)
  deps?: string[]; // dependency contract: ids of existing cards in the same project (must be completed before this one)
  calibrate?: boolean; // D1.6 moment ①: calibrate the requirement first (AI proposes acceptance criteria → confirm → write back), then execute
  budget?: number; // execution budget in CNY (opt-in; Waiting{cost} suspends on overspend)
}
export async function createCard(pid: string, input: CreateCardInput): Promise<{ card_id: string; session_id: string }> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { card_id: string; session_id: string };
}

/** POST /api/cards/:cardId/status —— mark status manually (state machine design: drag / manually mark done / failed / to-do) */
export async function markStatus(cardId: string, status: 'Done' | 'Failed' | 'Pending'): Promise<boolean> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

/** POST /api/cards/:cardId/executions —— start a new execution generation on a card (fork: derived from from_execution_id);
 *  new session = new execution; the original execution's event stream is kept for diffing. */
export async function forkExecution(cardId: string, fromExecutionId?: string): Promise<{ session_id: string; forked_from?: string | null }> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/executions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fromExecutionId ? { from_execution_id: fromExecutionId } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { session_id: string; forked_from?: string | null };
}

/** POST /api/cards/:cardId/calibrate —— D1.7 requirement calibration (AI explores and proposes acceptance criteria → confirm → write back) */
export async function calibrateCard(cardId: string): Promise<{ session_id: string }> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/calibrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { session_id: string };
}

/** GET /api/tasks/:sid —— TaskState of a single execution (= session) (by sid, not card id) */
export function getTask(sid: string): Promise<TaskState> {
  return req<TaskState>('/tasks/' + encodeURIComponent(sid));
}

/** POST /api/tasks/:sid/comments —— comments = the only control channel (comments are control: instructions / guidance / decisions);
 *  the server sends it to the engine via ACP session/prompt; WS user/message + assistant/message flow back into the comment thread. */
export async function postComment(sid: string, text: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error('comment ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/tasks/:sid/cancel —— stop; {ok:true} */
export async function cancelTask(sid: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/cancel', { method: 'POST' });
  if (!res.ok) throw new Error('cancel ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/fs/pick —— the server opens the native "choose folder" dialog and returns the absolute path directly (cancel → cancelled) */
export async function pickFs(): Promise<{ cancelled: boolean; path?: string }> {
  const res = await fetch(BASE + '/fs/pick', { method: 'POST' });
  if (!res.ok) throw new Error('fs/pick ' + res.status);
  return (await res.json()) as { cancelled: boolean; path?: string };
}

/** GET /api/fs/list?path= —— local directory browsing (pick a directory for a new project; directories first, hidden entries filtered) */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}
export interface FsList {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}
export function listFs(path?: string): Promise<FsList> {
  const q = path ? '?path=' + encodeURIComponent(path) : '';
  return req<FsList>('/fs/list' + q);
}

/** DELETE /api/projects/:pid —— remove a project.
 *  mode=archive: recoverable removal (session logs archived + SQLite flag; re-importing the same directory restores it automatically)
 *  mode=purge: full cleanup (deletes session logs + records); neither touches the user's project files */
export async function removeProject(pid: string, mode: 'archive' | 'purge'): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error('remove ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/projects —— register a project explicitly (interface suggested in design doc §5.1; id derived from name, idempotent) */
export async function createProject(path: string, name?: string): Promise<Project> {
  const res = await fetch(BASE + '/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { path, name } : { path }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as Project;
}

import type { CardState } from '../store/projection';
// ---------- Approval queue (P0: Waiting state machine) ----------

export interface ApprovalItem {
  id: number;
  project_id: string;
  execution_id: string;
  kind: 'plan' | 'permission' | 'acceptance' | 'cost' | 'calibrate' | 'checkpoint';
  payload: Record<string, unknown>;
  reason: string | null;
  outcome: 'approved' | 'rejected' | 'suspended' | null;
  comment: string | null;
  created_at: number;
  decided_at: number | null;
  suspended_at: number | null;
  task_title?: string;
  card_id?: string | null;
  card_kind?: string | null;
  /** Policy suggestion (P1 O6): captured history of similar decisions, count>=2; { scope, outcome, count } | null */
  policy_suggestion?: { scope: string; outcome: 'approved' | 'rejected'; count: number } | null;
}

/** GET /api/approvals?project= —— pending approval queue */
export function listApprovals(pid: string): Promise<ApprovalItem[]> {
  return req<ApprovalItem[]>('/approvals?project=' + encodeURIComponent(pid));
}

/** POST /api/tasks/:sid/waiting —— trigger Waiting{kind} (for testing/control) */
export async function triggerWaiting(sid: string, kind: string, reason: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/waiting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, reason }),
  });
  return res.ok;
}

/** POST /api/approvals/:id —— decide (approve/reject + comment delivered to the agent); remember=true captures a policy atom.
 *  Throws on failure (includes the server error body, e.g. a 409 acceptance merge conflict). */
export async function decideApproval(id: number, outcome: 'approved' | 'rejected', comment: string, remember = false): Promise<boolean> {
  const res = await fetch(BASE + '/approvals/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome, comment, remember }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body.slice(0, 300) || `${res.status}`);
  }
  return true;
}

// ---------- Policy learning (P1 O6: rules can be viewed and deleted) ----------

export interface PolicyRow {
  id: number;
  project_id: string;
  kind: string;
  scope: string;
  outcome: 'approved' | 'rejected';
  count: number;
  created_at: number;
  updated_at: number;
}

export function listPolicies(pid: string): Promise<PolicyRow[]> {
  return req<PolicyRow[]>('/policies?project=' + encodeURIComponent(pid));
}

export async function deletePolicy(id: number): Promise<boolean> {
  const res = await fetch(BASE + '/policies/' + id, { method: 'DELETE' });
  return res.ok;
}

/** GET /api/approvals/suspended —— suspended approvals (O5: a Waiting that times out is suspended automatically) */
export function listSuspendedApprovals(pid: string): Promise<ApprovalItem[]> {
  return req<ApprovalItem[]>('/approvals/suspended?project=' + encodeURIComponent(pid));
}

/** POST /api/approvals/:id/resume —— resume a single suspended item (the original session continues from the Waiting point) */
export async function resumeApproval(id: number): Promise<boolean> {
  const res = await fetch(BASE + '/approvals/' + id + '/resume', { method: 'POST' });
  return res.ok;
}

/** POST /api/projects/:pid/approvals/resume-all —— bulk resume */
export async function resumeAllApprovals(pid: string): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/approvals/resume-all', { method: 'POST' });
  return res.ok;
}

/** GET /api/presets —— available agent presets (per-task tool/persona assembly) */
export interface PresetInfo { id: string; name: string; description: string }
export function listPresets(): Promise<PresetInfo[]> {
  return req<PresetInfo[]>('/presets');
}

// ---------- Preset profiles (P0 §2.6: three-axis combination = named profile) ----------

export interface Profile {
  id: string;
  project_id: string;
  name: string;
  is_builtin: boolean;
  mode: 'normal' | 'plan' | 'goal';
  setting: 'light' | 'balanced' | 'delivery';
  approval: 'ask' | 'auto' | 'yolo';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  is_default: boolean;
}

/** GET /api/projects/:pid/presets —— profile list (with the three axes + default flag) */
export function listProfiles(pid: string): Promise<Profile[]> {
  return req<Profile[]>('/projects/' + encodeURIComponent(pid) + '/presets');
}

/** POST /api/projects/:pid/presets —— custom profile (save a new three-axis combination) */
export async function createProfile(pid: string, input: Omit<Profile, 'project_id' | 'is_builtin' | 'is_default'>): Promise<Profile | null> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as Profile;
}

/** POST /api/projects/:pid/presets/:id/default —— set the project default */
export async function setDefaultProfile(pid: string, id: string): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/presets/' + encodeURIComponent(id) + '/default', { method: 'POST' });
  return res.ok;
}

/** DELETE /api/projects/:pid/presets/:id —— delete a custom preset */
export async function deleteProfile(pid: string, id: string): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/presets/' + encodeURIComponent(id), { method: 'DELETE' });
  return res.ok;
}

/** Three axes → display labels (new-card dropdown / preset management) */
export const MODE_LABEL: Record<Profile['mode'], string> = { normal: 'Normal', plan: 'Plan', goal: 'Goal' };
export const SETTING_LABEL: Record<Profile['setting'], string> = { light: 'Light', balanced: 'Balanced', delivery: 'Delivery' };
export const APPROVAL_LABEL: Record<Profile['approval'], string> = { ask: 'Ask', auto: 'Auto', yolo: 'Yolo (hands off)' };
export const SANDBOX_LABEL: Record<Profile['sandbox'], string> = { 'read-only': 'Read-only', 'workspace-write': 'Write project', 'danger-full-access': 'Full access' };

export function profileSummary(p: Profile): string {
  return `${MODE_LABEL[p.mode]} × ${SETTING_LABEL[p.setting]} × ${APPROVAL_LABEL[p.approval]}`;
}

// ---------- Metrics (M4 §5.2 sequential task curve / metrics panel) ----------

/** Metrics for a single execution (a metrics table row) */
export interface MetricRow {
  id: number;
  project_id: string;
  task_id: string;
  brief_snapshot: Array<{ id: string; title: string; score: number }>;
  outcome: string;
  cited_entries: string[];
  turns: number;
  steps: number;
  group_tag?: string;
  verified?: boolean;
  cost: number;
  cache_hit: number;
  in_tokens: number;
  cache_tokens: number;
  out_tokens: number;
  reason_tokens: number;
  created_at: number;
}

/** GET /api/metrics?project= —— all execution metrics for the project (newest first; the frontend reverses it to draw the sequence curve) */
export function getMetrics(pid: string): Promise<MetricRow[]> {
  return req<MetricRow[]>('/metrics?project=' + encodeURIComponent(pid));
}

export type DebtStatus = 'idle' | 'useful' | 'unused' | 'toxic';

export interface NoteDebt {
  injected: number;
  cited: number;
  failedWhenCited: number;
  status: DebtStatus;
}

export interface KbNoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string[];
  tags: string[];
  keywords: string[];
  summary: string;
  antiPatterns?: string[];
  applicability?: string;
  source: { kind: string; ref: string };
  validFrom: number;
  validUntil: number | null;
  trust: 'human-approved' | 'agent-generated' | 'unverified';
  debt?: NoteDebt;
}

export function listKbNotes(pid: string): Promise<KbNoteRow[]> {
  return req<KbNoteRow[]>('/kb/notes?project=' + encodeURIComponent(pid));
}
/** GET /api/kb/search —— server-side fused retrieval (scored on title/content/keywords/summary/tags; unused/toxic demoted) */
export function searchKbNotes(pid: string, q: string): Promise<KbNoteRow[]> {
  return req<KbNoteRow[]>('/kb/search?project=' + encodeURIComponent(pid) + '&q=' + encodeURIComponent(q));
}


export async function invalidateKbNote(id: string): Promise<boolean> {
  const res = await fetch(BASE + '/kb/notes/' + encodeURIComponent(id) + '/invalidate', { method: 'POST' });
  return res.ok;
}

/** POST /api/kb/notes/:id/stable —— pin into / unpin from the cross-task stable prefix */
export async function setKbNoteStable(id: string, pinned: boolean): Promise<KbNoteRow | null> {
  const res = await fetch(BASE + '/kb/notes/' + encodeURIComponent(id) + '/stable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) return null;
  return (await res.json()) as KbNoteRow;
}

// ---------- Simple chats (group A: the loose entry point of the two-tier model) ----------

export interface ChatSummary {
  session_id: string;
  title: string | null;
  status: string;
  turns: number;
  steps: number;
  last_text: string | null;
  started_at: number | null;
}

/** POST /api/projects/:pid/chats —— create a standalone chat (not attached to a card) */
export async function createChat(pid: string): Promise<{ session_id: string }> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/chats', { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { session_id: string };
}

export function listChats(pid: string): Promise<ChatSummary[]> {
  return req<ChatSummary[]>('/projects/' + encodeURIComponent(pid) + '/chats');
}

export function getChat(sid: string): Promise<TaskState> {
  return req<TaskState>('/chats/' + encodeURIComponent(sid));
}

/** POST /api/chats/:sid —— send a message (blocks until the agent's end_turn) */
export async function sendChat(sid: string, text: string): Promise<{ stop_reason: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { stop_reason: string };
}

/** POST /api/chats/:sid/title —— user renames the title (once pinned, auto-generation stops) */
export async function renameChat(sid: string, title: string): Promise<boolean> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return true;
}

/** POST /api/chats/:sid/fork —— fork the chat (copy history into a new session) */
export async function forkChat(sid: string): Promise<{ session_id: string; forked_from?: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/fork', { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { session_id: string; forked_from?: string };
}

/** POST /api/chats/:sid/archive —— archive the chat (remove from list) */
export async function archiveChat(sid: string): Promise<boolean> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/archive', { method: 'POST' });
  return res.ok;
}

/** GET /api/projects/:pid/chats/archived —— archived chat list */
export function listArchivedChats(pid: string): Promise<ChatSummary[]> {
  return req<ChatSummary[]>('/projects/' + encodeURIComponent(pid) + '/chats/archived');
}

/** POST /api/chats/:sid/restore —— restore an archived chat */
export async function restoreChat(sid: string): Promise<boolean> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/restore', { method: 'POST' });
  return res.ok;
}

/** POST /api/chats/:sid/promote —— promote to a task (chat context goes into the brief → the new card runs automatically) */
export async function promoteChat(sid: string, input: { title?: string; description?: string }): Promise<{ card_id: string; session_id: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { card_id: string; session_id: string };
}

/** POST /api/chats/:sid/kb —— save to the knowledge base (chat conclusions → KB note) */
export async function saveChatToKb(sid: string, title?: string): Promise<{ note_id: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/kb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { note_id: string };
}
