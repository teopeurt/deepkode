# Helmsman architecture deep dive

This document walks through how Helmsman is put together: which processes run, how a task moves from "card" to "merged change", where state lives, and how the frontend stays in sync. The last section lists gaps and bugs found while reading the code. They are worth knowing before you rely on a feature the UI or README advertises.

File references use `path:line` and match the tree at the time of writing.

---

## 1. The big picture

Helmsman is a task board for coding agents. You register a project directory, create **cards**, and each card is executed by one or more agent **sessions** (called *executions* or *generations*). When a session finishes, its output is distilled into a per-project **knowledge base**, and the next task's first prompt is assembled with relevant knowledge from it.

There are only two processes:

```
 Browser ──HTTP/WS──▶ Vite dev server :5173 ──proxy /api, /api/events──▶ dsh engine :3081
 (React + zustand)                                                          │
                                                                            ├─ DeepSeek Harness plugins (agents, tools, sandbox, LLM, JSONL persistence, CWL eviction…)
                                                                            └─ Helmsman plugins (dsh/helmsman-*.js): HTTP API, projection, orchestration,
                                                                               approvals, acceptance gate, knowledge base, worktrees, SQLite
```

- **Engine (`dsh/`)**: a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) process booted by `dsh/launcher.mjs` from the composition file `dsh/cordis.yml`. All Helmsman business logic runs *inside* this process as cordis plugins, so there is no separate backend service. The v1 design (a separate `server-ts` process speaking ACP to the engine, with a Rust observer tailing JSONL) has been retired. Several comments and `dsh/README.md` still describe that v1 world.
- **Frontend (`web/`)**: a Vite + React 18 + zustand SPA. It holds a local copy of the server's projection, refreshes it over REST, and uses a WebSocket (with an SSE fallback) as a "something changed" signal.

### 1.1 The cordis composition

`dsh/cordis.yml` is a list of plugins, loaded in order. Roughly:

| Group | Plugins | Notes |
|---|---|---|
| Session plumbing | `dsh-session-title`, `dsh-session-title-first-prompt-llm`, `dsh-session-persistence-jsonl`, `dsh-session-checkpoint-policy`, `dsh-session-projection` | Sessions persist as `.sessions/**/session.jsonl` (`HELMSMAN_SESSIONS_ROOT`). |
| LLM | `dsh-llm-deepseek` | `deepseek-v4-flash` / `deepseek-v4-pro`, 128K context, thinking enabled, `reasoningEffort: max`. |
| Agent spine | `dsh-agent-spine-demo` | No pre-built agents; the Helmsman persona is defined here. |
| Context management | `dsh-token-meter`, `dsh-compaction-basic` (compacts at 80%), `dsh-cwl` | `dsh-cwl` is the in-house structured eviction plugin (see §8). |
| Tools | bash, fs, subagent (spawn/fork), workflow, ralph, todo | `dsh-fs-sandbox` + `dsh-sandbox-policy: workspace-write`: an agent can only write its cwd and `/tmp`. |
| Approvals | `dsh-user-approval` (`policy: ask`) | Fails closed when nothing answers. Helmsman's answerer is `helmsman-approval`. |
| Presets | `dsh-agent-presets` | Roots at `dsh/agent-presets/` (`code-concise`, `distill`, `guard`). |
| Helmsman | `model-select`, `webserver` (:3081), `helmsman-tasks`, `-acceptance`, `-approval`, `-kb`, `-worktree`, `-board`, `-persist`, `-api` | Wired to each other through `ctx.provide` / `ctx.get` services. |

The other `*.cordis.yml` files (`board`, `gateway`, `kb`, `tasks`, …) are trimmed copies used to validate one plugin at a time on other ports.

### 1.2 Helmsman plugins and the services they provide

| Plugin | File | Provides | Role |
|---|---|---|---|
| board | `dsh/helmsman-board.js` | `helmsmanBoard` | Owns the in-memory **projection**. Folds every `session/event` into it, and pushes events to the browser over WS `/api/events` (SSE fallback). |
| persist | `dsh/helmsman-persist.js` | `helmsmanStorage` | Opens SQLite (`Storage`), rebuilds the projection at startup by replaying JSONL logs, then merges it into the board. |
| storage | `dsh/helmsman-storage.js` | (class) | better-sqlite3 schema + queries (compiled from TS; that is why it uses `\uXXXX` escapes and `void 0`). |
| tasks | `dsh/helmsman-tasks.js` | `helmsmanTasks` | `createTask` / `sendComment` / `forkTask` / `cancelTask` / `getTaskStatus` on top of `ctx.agents`. |
| worktree | `dsh/helmsman-worktree.js` | `helmsmanWorktree` | `git worktree add/remove`, merge back with `--no-ff`. |
| kb | `dsh/helmsman-kb.js` | `helmsmanKb` | Knowledge base: auto-capture on Done, hybrid retrieval, prompt assembly, `/api/kb/*`. |
| embedding | `dsh/helmsman-embedding.js` | (module) | Local `bge-small-zh-v1.5` embeddings via transformers.js, lazily loaded, degrade to `null`. |
| acceptance | `dsh/helmsman-acceptance.js` | `helmsmanAcceptance` | Acceptance gate on Done: runs the card's criteria command, collects git evidence, then suspends for approval or merges. |
| approval | `dsh/helmsman-approval.js` | — | The `approval/request` answerer, plus `/api/approvals*` and `/api/policies*`. |
| api | `dsh/helmsman-api.js` | — | Projects, cards, tasks, chats, presets/profiles, settings, metrics, pricing, experiments, fs browsing, file preview, repo status. |
| model-select | `dsh/model-select.js` | — | Per-session model switching through a shared JSON file (not wired up, see §10). |
| gateway | `dsh/helmsman-gateway.js` | — | `/api/health`, `/api/ping`. Only used by `gateway.cordis.yml`. |
| guard preset | `dsh/agent-presets/guard/guard-plugin.js` | — | `tools/pre-execute` hook: dangerous bash commands → `{kind:'ask'}` → approval queue. |

---

## 2. Domain model

```
Project ─┬─ Card (asset: requirement | bug | task, milestone, deps[], criteria, budget)
         │    └─ Execution 1..n  ==  one dsh session  ==  TaskState
         └─ Chat (a standalone session, not on the board)
```

- **Card = asset**: the thing you want done. Its board status is the status of its **latest** execution (`exec_order` last entry, `latestExecutionState` in `dsh/helmsman-projection.js:61`).
- **Execution = session**: forking or re-running a card creates a *new* session (a new generation). The old event stream is kept so generations can be compared.
- **Chat**: a "simple session" for Q&A. It never appears on the board, and can be promoted to a card.

### 2.1 The projection (server-side source of truth for live state)

`newProjection()` → `{ projects: {pid: {id,name,path,cards:{}, chats:{}}}, sessionProject: {sid→pid}, sessionCard: {sid→cardId|''} }`.

Each `TaskState` (`newTaskState`, `dsh/helmsman-projection.js:10`) holds `status`, `turns`, `steps`, `tool_calls`, bounded `activities` (200: `Text` / `Reasoning` / `ToolStart` / `ToolResult`, each with `at` + `turn`), bounded `comments` (200, user messages only), `usage` buckets, `model`, `title`, `waiting`, `worktree`, `brief_snapshot`, and so on.

`foldTask` (`:130`) is a pure, incremental reducer over dsh session events:

| Event | Effect |
|---|---|
| `turn/start` | Pending → Running, `turns++`, `current_turn` |
| `step/start` | `steps++` |
| `turn/end` | unless `waiting` is set: `completed` → Done, `cancelled` → Cancelled, else Failed |
| `assistant/message` | accumulate `usage`; append `text` / `reasoning` blocks as activities (merged within a turn) |
| `user/message` (source `user`) | push a comment |
| `tool/call` / `tool/result` | record the tool call and its error flag, push `ToolStart` / `ToolResult` activities |
| `session/title`, `request/context` | title, model |
| `assistant/chunk`, `text-chunks`, `reasoning-chunks` | ignored (streaming only; the final text comes from `assistant/message`) |

Because the reducer is pure, live folding and startup replay go through the same code path.

### 2.2 SQLite (`dsh/.helmsman.db`, `HELMSMAN_DB`)

Tables in `dsh/helmsman-storage.js`:

| Table | Purpose |
|---|---|
| `projects` | id, name, path, `archived` flag (soft removal; re-importing the same path restores it) |
| `cards` | card metadata incl. `criteria_json`, `deps_json`, `budget` |
| `executions` | session → card mapping (the authority for restart recovery), worktree path/branch |
| `chat_sessions` | which sessions are simple chats |
| `settings` | per-project key/value (`retrieval_threshold`, `brief_entries`) |
| `kb_notes` | knowledge entries: content/tags/keywords/summary/anti-patterns/applicability, bitemporal `valid_from`/`valid_until`, `trust`, `version` |
| `approvals` | persisted approvals (currently only `acceptance`) |
| `policies` | learned decision counts per (kind, scope, outcome) |
| `profiles` | named three-axis presets (4 built-ins seeded per project) |
| `metrics` | per-execution metrics (schema only; nothing writes it, see §10) |
| `tasks`, `deleted_projects` | v1 leftovers / purge markers |

Session *content* never goes into SQLite. It lives in the JSONL logs, and the projection is rebuilt from them.

---

## 3. Lifecycle of a card

```
NewTaskModal ──POST /api/projects/:pid/cards──▶ board.ensureCard + storage.upsertCard     (card only, Pending)
Kanban "Run" ──POST /api/cards/:id/executions──▶ tasks.createTask
                                                   1. worktree.prepare(repo, card, key) → .helmsman/worktrees/<key> on branch helmsman/<card>-<key>
                                                   2. board.registerSession + storage.upsertExecution   (register BEFORE the agent emits events)
                                                   3. agents.create({sessionId, meta:{cwd: worktree}, setup: mount preset?})
                                                   4. kb.assembleTaskPromptFull(brief) → first prompt (+ brief_snapshot)
                                                   5. agent.followup(first prompt)
engine runs the agent ──session/event──▶ board.fold → projection ──WS frame──▶ browser (debounced refetch)
                         turn/end & Done ──▶ kb auto-capture (distill session → kb_notes)
                                        └─▶ acceptance.runGate
                                              • run card.criteria as a shell command (exit 0 = pass) in the worktree
                                              • collect git status / diff --stat evidence
                                              • default profile setting=delivery & approval≠yolo → t.waiting={kind:'acceptance'} + approvals row
                                              • otherwise → worktree.merge (add, commit, merge --no-ff into the main repo)
Approval card "Approve" ──POST /api/approvals/:id──▶ decideApproval → acceptance.approveMerge (merge worktree, clear waiting)
                       "Reject" ──────────────────▶ rejectClear (keep the worktree for manual handling)
```

Details worth knowing:

- **Isolation** (`dsh/helmsman-tasks.js:25-37`): only card executions in a git repo with a `HEAD` get a worktree. Otherwise, or if `git worktree add` fails, the agent runs in the shared project directory and `t.isolated = true` (the UI shows "⚠ Running in shared directory"). `.helmsman/worktrees/` is added to `.git/info/exclude`.
- **Comments are the control channel**: `POST /api/tasks/:sid/comments` calls `agent.followup` with a user message. If the agent isn't live (e.g. after a restart), it is first resumed with `agents.resume`.
- **Forking a chat** (`forkTask`) copies the source session's sequenced events as the `seed` of a new session and folds them into the projection by hand.
- **Calibration** (`POST /api/cards/:id/calibrate`) starts a session prompted to propose acceptance criteria and end with the marker `[ACCEPTANCE CRITERIA DONE]`, flagged `calib: true`.
- **Waiting** (`t.waiting`) is the "paused awaiting a decision" state. `turn/end` and `finishTask` leave it alone, and the frontend renders it as a pseudo-status `Waiting`. Today it is only set by the acceptance gate and by the test endpoint `POST /api/tasks/:sid/waiting`.

### 3.1 Agent presets vs. profiles

There are two separate concepts:

- **Engine presets** (`dsh/agent-presets/*`) are dsh tool/persona bundles mounted per agent in `createTask`'s `setup` when a `preset` id is passed: `code-concise` (persona + bash + fs), `distill` (no-tools persona), `guard` (command allowlist).
- **Profiles** (`profiles` table, `/api/projects/:pid/presets`) are named combinations of four axes: mode (`normal|plan|goal`) × setting (`light|balanced|delivery`) × approval (`ask|auto|yolo`) × sandbox. The four built-ins are Standard, Cautious, Surfing and Delivery. Today the only consumer is the acceptance gate, which reads the project **default** profile (see §10).

---

## 4. Chats

`POST /api/projects/:pid/chats` creates an agent with no first message (`sendBrief: false`) and records it in `chat_sessions`. The chat view (`web/src/views/SessionView.tsx`) creates the chat lazily on first send, interleaves comments + reasoning + text by timestamp, groups tool calls into chips, and shows streaming text until the REST refetch catches up. Chats can be renamed (`sessionTitle.rename`, which pins the title), forked, archived/restored, promoted to a card, and "saved to KB" (see §10).

---

## 5. Knowledge base

### 5.1 Capture

`helmsman-kb` listens to `session/event`. On `turn/end` for a registered session whose projection status is **Done** and that produced Text, it takes the last 2000 characters of Text output and runs **distill**:

1. `distillWithEngine` (`dsh/helmsman-kb.js:291`) creates a throwaway agent with `cwd: /tmp`, removes every restrictable tool, sends `buildDistillPrompt` (title + output tail + a strict JSON schema), waits for idle (120 s timeout), and parses the JSON (`parseDistillJson` tolerates code fences).
2. On success it makes a note with `trust: 'agent-generated'`, including `anti_patterns` and `applicability` (the "WikiSkill" fields). On failure it falls back to a rule-based note: the title + the first 10 text activities.
3. If a note from the same session already exists, it is upgraded in place (`version + 1`) instead of duplicated.

Manual notes (`POST /api/kb/notes`) default to `trust: 'human-approved'`. `POST /api/kb/notes/:id/invalidate` sets `valid_until` (bitemporal soft delete). `POST /api/kb/notes/:id/stable` toggles the `stable` tag.

### 5.2 Retrieval (`retrieveHybrid`, `:65`)

- **Rule channel**: `deriveQueries` tokenizes on `[^a-z0-9一-鿿]+` (ASCII words and runs of CJK), keeps up to 8 tokens of length ≥ 2, and scores each note: title hit +3, keyword +2, tag +1.5, content +1.
- **Semantic channel**: cosine similarity between bge embeddings of the query and of `title + summary + content` (cached per note by `updatedAt`). For Chinese queries the bge instruction prefix is prepended. That prefix is deliberately kept in Chinese because it is input for a Chinese model.
- **Fusion**: a rule hit scores `0.7·rule + 0.3·sim`. A semantic-only hit with `sim ≥ 0.5` scores `0.8·sim`. Results are filtered at `threshold` (0.15) and cut at `limit`. If embeddings are unavailable, rules alone are used.

### 5.3 Assembly into the first prompt (`assembleTaskPromptFull`, `:575`)

```
-- Project stable knowledge ... --          ← notes tagged `stable` (stable prefix → KV-cache friendly)
• <title>: <content…>

Task: <brief>

-- Knowledge-base entries relevant to this task (sorted by relevance) --
[0.72] <title>
    Applies when: …
    Avoid: …
```

The design idea is **prefix partitioning**: the stable block is identical across tasks, so DeepSeek's KV cache can reuse it and the cost drops. The hit list (`kbHits`) is stored on the execution as `brief_snapshot` and shown in the drawer's Brief tab.

With `internalize: true` (experiment group B), the hits are instead rendered as a "project skill handbook" with full content, applicability and anti-patterns, plus an instruction not to expand the task scope (`renderInternalizedSkill`).

**Knowledge debt** (`scoreNoteDebt`) classifies notes from past metrics as `idle` / `useful` / `unused` (injected ≥ 2× but never cited) / `toxic` (half or more of its citations ended in failure). The intent is to stop assembling unused and toxic notes (see §10 for why that doesn't happen yet).

---

## 6. Approvals and policies

- **Tool permissions**: when a tool returns `{kind:'ask'}` (e.g. from the guard preset), dsh calls the `approval/request` waterfall. `helmsman-approval` answers by parking a pending promise in memory (`pending` Map, 5-minute timeout → `'unavailable'`, which fails closed). `POST /api/approvals/:id` resolves it with `allowed-once` or `rejected`, and optionally sends the comment to the agent as a follow-up message.
- **Acceptance approvals** are persisted in SQLite and merged into `GET /api/approvals`.
- **Policies** (`policies` table) count decisions per (kind, scope, outcome). Once a count reaches 2, `policySuggestion` can offer "adopt the usual decision", and the approval card renders it as a one-click recommendation.
- **The guard preset** (`guard-plugin.js`) matches bash commands against regexes (rm -rf, sudo, git push / reset --hard / clean -f / branch -D, curl|sh, mkfs, shutdown, kill -9, chmod 777, chown -R) after a prefix allowlist (`rm -rf /tmp/`, `rm -rf dist`, `rm -rf node_modules`, …).

---

## 7. Persistence and restart recovery

At startup `helmsman-persist`:

1. loads projects and cards from SQLite into a fresh projection;
2. builds a `session → card` map from `executions`;
3. walks `.sessions/**/session.jsonl`, reading the header (cwd, id) and the sequenced events of each file. It maps each session to a project (via the execution map, or by matching cwd → repo root → registered project paths) and to a card (its execution card, or an implicit card named after the session);
4. folds all events, marks `recovered: true`, and turns any execution still `Running` into `Failed` (the previous process died mid-turn);
5. moves sessions listed in `chat_sessions` from implicit cards to `project.chats`;
6. copies everything into the live board projection.

The board then keeps folding live events.

---

## 8. Cost, metrics and the CWL experiments

- **Pricing** (`dsh/helmsman-api.js:20-52`): DeepSeek V4 peak/off-peak prices in CNY per million tokens. Peak is Mon–Fri 9–12 and 14–18 Beijing time, and off-peak is half price. A model id containing `pro` uses pro prices. Reasoning tokens are billed at the output price.
- **`GET /api/metrics`** derives one row per card execution from the projection (turns, steps, token buckets, cost at the execution's finish time). The Metrics view plots cost / cumulative cost / turns / cache hit along execution order.
- **CWL** (`dsh-cwl`, external plugin): before each LLM step it checks a token budget (`DSH_CWL_BUDGET`) and deterministically replaces the oldest completed *episodes* with stubs, keeping causal structure and never evicting user messages. `benchmarks/` contains the two harnesses and reports:
  - Round 1 (`REPORT-round1.md`): 6 short tasks under an artificially low budget. Eviction hurt: 103 evictions, 2.5× the cost. Phase merging plus a dependency graph (v2) cut evictions by 90%, but there was still no net benefit for short tasks.
  - Round 2 (`REPORT-round2.md`): 12 rounds in one long chat with a 30K budget. Input tokens -64%, steps -13%, output -25%, and nothing broke.

---

## 9. Frontend architecture (`web/src`)

```
main.tsx → App.tsx
  ├─ store/ui.ts          hash router (#pid=&view=&open=&tab=&t=), modals, toasts, pending (offline) projects
  ├─ store/projection.ts  zustand mirror of the server projection + derived state + WS folding
  ├─ api/client.ts        typed REST wrappers for every endpoint
  ├─ api/events.ts        WebSocket client with exponential backoff (1s → 30s)
  ├─ views/               HomeView, ProjectHomeView, KanbanView, TaskDetailDrawer, SessionView (chat),
  │                       SessionDetailView (full-screen session), SessionsView (history), GraphView,
  │                       KnowledgeBaseView, FilesView, MetricsView, ApprovalsView, ExperimentView (hidden)
  ├─ components/          UI primitives, many ported from "Beautiful UI" (MIT) and rewritten onto 25 theme tokens
  └─ theme/               6 built-in themes, atmosphere layer, importable skins (theme.json / theme.css / zip)
```

**Data flow.** The rule is that the engine is the only writer. Every user action is a POST, and state comes back through the server.

1. On boot: `loadProjects()`, parse the hash, `loadProject(pid)` (which loads all cards plus every chat's full TaskState), then connect the WS.
2. Every WS frame goes to `applyWsEvent`. It appends `text-chunks` to `streams[activeSessionId]`, accumulates `usage`, marks `turn/end`, and bumps `revision`.
3. `App` debounces `revision` changes (400 ms) and calls `refreshTargets`, which re-fetches the current project and open card over REST. The server projection is authoritative, and the WS only says *when* to refresh.
4. Derived values are computed on render, never stored: `cardStatus`, `effectiveStatus` (Waiting), `cardUnmet` (dependency gate), cost, cache hit.

**UI invariants** stated in comments ("red lines"): the frontend never mutates status locally; Running and Waiting cards are locked (no drag, comment-only); blocked-by-dependency is always recomputed; cost is shown only when usage exists.

**Theming**: `ThemeProvider` writes 25 semantic tokens to `documentElement` via CSSOM. A "skin" can override a subset of tokens, inject a whole `theme.css`, and set a background. All component CSS lives in `styles/base.css` and uses tokens only, so skins can restyle everything.

---

## 10. Known gaps and bugs

These are things the UI, README or comments describe that the code doesn't do (or does differently). Severity is my judgment.

### Functional gaps (feature advertised, not wired up)

1. **New cards don't run automatically.** The modal says "Create and run", and comments say "a new card runs automatically", but `POST /api/projects/:pid/cards` (`dsh/helmsman-api.js:205`) only creates the card. An execution starts only when you press **Run** on the board (`POST /api/cards/:id/executions`). The `preset`, `calibrate` and `budget` fields the modal sends are ignored or only stored.
2. **Profiles barely affect execution.** The chosen profile isn't passed to `createTask`. Mode (plan/goal), approval (auto/yolo) and sandbox have no runtime effect. Only the acceptance gate reads the project's *default* profile. The guard preset, and therefore the command allowlist, is never mounted unless a caller passes `preset: 'guard'`.
3. **Plan / calibrate / checkpoint markers are never detected.** `detectPlanCompletion` and `extractMarkerText` (`dsh/helmsman-projection.js:359-380`) are exported but unused. Nothing turns `[PLAN DONE]` or `[ACCEPTANCE CRITERIA DONE]` into a `Waiting`, and calibrated criteria are never written back to the card.
4. **Dependencies don't gate anything server-side.** `validateDeps` and `depsMet` are unused, card creation doesn't validate deps, and nothing auto-starts a card when its upstream finishes. On the frontend, `GraphView` (`web/src/views/GraphView.tsx:26,85,101`) and the drawer read `deps` from the latest *execution*, but executions never carry `deps` (only cards do), so the graph shows no edges.
5. **Metrics aren't persisted.** `insertMetric` is never called, so `storage.listMetrics()` is always empty. That has three effects: knowledge debt (§5.3) is always `idle`, the KB "never cited / possibly toxic" filters are always empty (notes also never carry a `debt` field), and the drawer's history-based cost backfill never has data. `/api/metrics` hard-codes `verified: false` (`dsh/helmsman-api.js:729`), so the Metrics view reports a **0% acceptance pass rate** instead of "no acceptance criteria".
6. **Settings are saved but not read.** `retrieval_threshold` and `brief_entries` are stored by `PUT /api/projects/:pid/settings`, but assembly hard-codes `threshold: 0.15, maxKbEntries: 5` (`dsh/helmsman-kb.js:589-590`). The `demote` map is computed and passed down but never applied in `retrieveHybrid`.
7. **Model switching is a no-op.** The chat views POST to `/api/sessions/:sid/model`, but no plugin registers that route, and nothing writes `.helmsman/model-selection.json`, which `model-select.js` reads.
8. **"Save chat to KB" saves nothing.** `POST /api/chats/:sid/kb` returns `{ note: null }` (`dsh/helmsman-api.js:682`), yet the UI toasts "Saved to knowledge base".
9. **Policy learning is half-wired.** `rememberPolicy` is defined but never called, and the `remember` flag is ignored. `policy_suggestion` is never attached to approval items, so the recommendation UI never appears.
10. **No concurrency limit.** The README lists "a limit on simultaneous tasks", but none exists.
11. **The Experiment view is hidden for good reason.** `/api/experiments/compare` returns `{a, b: []}`, while the view expects `{groups, delta, verdict}` and would crash.

### Bugs

12. **Approval decisions from the drawer and session page never find the acceptance approval.** Both look for `a.outcome === null` (`web/src/views/TaskDetailDrawer.tsx:171`, `SessionDetailView.tsx:173`), but acceptance items in `GET /api/approvals` have no `outcome` field (it is `undefined`), so the user gets "No pending approval found". The Approvals view itself works.
13. **Permission approvals get a random project id.** `project_id` is `'p-' + Date.now()` (`dsh/helmsman-approval.js:42`), so `?project=` filtering hides every tool-permission request from the Approvals view.
14. **Approval id collisions.** In-memory permission ids (1, 2, …) and SQLite acceptance ids share the same `/api/approvals/:id` namespace. The handler checks SQLite first (`:155`), so permission request #1 can be routed to acceptance approval #1.
15. **Worktree key collisions.** `worktree.prepare(cwd, card_id, sid.slice(0, 8))` (`dsh/helmsman-tasks.js:30`) uses `task-` plus 3 hex characters (4096 values). Paths are `.helmsman/worktrees/<key>` regardless of card, so collisions make `git worktree add` fail, and the execution silently runs in the shared directory.
16. **Startup replay can abort on one bad log.** `dirname` is used but not imported in `dsh/helmsman-persist.js:151` (only `basename` and `resolve` are imported). A `session.jsonl` without an `id` in its header throws a `ReferenceError`, which aborts the whole replay. The error is caught and logged, and every session is then missing from the board.
17. **Live updates and streaming are keyed to the wrong session.** The board attaches `id` to every WS frame, but `applyWsEvent` only updates `activeSessionId` on events with `type === 'session'` (`web/src/store/projection.ts:630`). Otherwise it is set only when the user sends a chat message. With several tasks running, streamed text and live usage pile onto whichever session was set last. Using `ev.id` directly would fix it.
18. **Tool arguments missing in the session view.** `SessionDetailView` looks up tool arguments by tool *name* in a map keyed by `call_id` (`web/src/views/SessionDetailView.tsx:131`), so arguments never show. (`TrajectoryView` does this correctly.)
19. **Non-persisted mutations.** Manual status marks (`POST /api/cards/:id/status`), chat archive/restore flags, and cards created by chat promotion (no `upsertCard`, and no execution started) live only in memory and disappear on restart.
20. **Project registration without a name fails.** `createProject` omits `name` when it is empty (`web/src/api/client.ts:206`), but the server requires it (400). `DirModal` always passes one, so this only bites other callers.
21. **Peak-hour mismatch.** The frontend `isPeakHour` (`web/src/store/projection.ts:135`) ignores weekends; the backend's doesn't.
22. **Pre-existing type errors.** `tsc -b` reports 15 type errors in `web/src/views/SessionView.tsx` (unrelated to the translation; `vite build` still succeeds).

### Security notes (it's a local single-user tool, but still)

23. **No authentication, exposed to the LAN.** The engine binds `127.0.0.1`, but the Vite dev server listens on `0.0.0.0` and proxies `/api`. Anyone on the same network can therefore browse your home directory (`/api/fs/list`, `/api/fs/find`), register any directory as a project, read files in it, and start agents in it. Consider `host: '127.0.0.1'` in `web/vite.config.ts`.
24. **Acceptance criteria are run as shell commands.** `runAcceptance` (`dsh/helmsman-acceptance.js:59`) passes `card.criteria` to `exec`. That is by design, but any client that can create a card can run arbitrary commands, which combines badly with item 23.
25. **The guard allowlist is prefix-based**, so `rm -rf /tmp/x && rm -rf ~` matches the allowed prefix `rm -rf /tmp/` and skips every danger check. Chained commands (`;`, `&&`, `|`) should be split before matching.

---

## 11. API reference (engine on :3081)

| Area | Endpoints |
|---|---|
| Health | `GET /api/health`, `GET /api/ping` (gateway composition only), `GET /api/board/stats` |
| Events | `WS /api/events` (upgrade), `GET /api/events` (SSE) |
| Projects | `GET/POST /api/projects`, `GET/DELETE /api/projects/:pid` (`{mode: archive|purge}`) |
| Cards | `GET/POST /api/projects/:pid/cards`, `GET /api/cards/:id`, `POST /api/cards/:id/status`, `POST /api/cards/:id/executions`, `POST /api/cards/:id/calibrate` |
| Tasks | `POST /api/tasks`, `GET /api/tasks/:sid`, `POST /api/tasks/:sid/comments`, `POST /api/tasks/:sid/cancel`, `POST /api/tasks/:sid/waiting` |
| Chats | `GET/POST /api/projects/:pid/chats`, `GET /api/projects/:pid/chats/archived`, `GET/POST /api/chats/:sid`, `POST /api/chats/:sid/{fork,archive,restore,title,promote,kb}` |
| Approvals | `GET /api/approvals?project=`, `GET /api/approvals/pending`, `GET /api/approvals/suspended`, `POST /api/approvals/:id`, `POST /api/approvals/:id/resume`, `POST /api/projects/:pid/approvals/resume-all` |
| Policies | `GET /api/policies?project=`, `DELETE /api/policies/:id` |
| Profiles | `GET/POST /api/projects/:pid/presets`, `POST /api/projects/:pid/presets/:id/default`, `DELETE /api/projects/:pid/presets/:id`; engine presets: `GET /api/presets` |
| Knowledge | `GET /api/kb/search?q=&project=`, `GET/POST /api/kb/notes`, `POST /api/kb/notes/:id/invalidate`, `POST /api/kb/notes/:id/stable`, `POST /api/kb/distill` |
| Workspace | `GET /api/projects/:pid/files`, `GET /api/projects/:pid/files/read?path=`, `GET /api/projects/:pid/repo-status`, `GET/PUT /api/projects/:pid/settings` |
| Worktrees | `POST /api/worktree/{prepare,merge,discard}` |
| Metrics | `GET /api/metrics?project=`, `GET /api/pricing`, `POST /api/experiments/run`, `GET /api/experiments/compare?project=` |
| Local FS | `POST /api/fs/pick` (macOS folder dialog), `GET /api/fs/list?path=`, `GET /api/fs/find?name=&max=` |

---

## 12. Notes on the English translation

The repository was originally written in Chinese and has been translated to English. Behavior changes that came with it:

- The agent completion markers are now `[PLAN DONE]`, `[ACCEPTANCE CRITERIA DONE]` and `[CHECKPOINT DONE]` (formerly `【计划完毕】`, `【验收标准完毕】`, `【阶段完毕】`). Old session logs that contain the Chinese markers won't match, but nothing consumes the markers today anyway (§10.3).
- All LLM-facing prompts (distill prompt, assembly headers, calibration brief, selection-action prompts, probe messages) are now English.
- The built-in profile names are now Standard / Cautious / Surfing / Delivery. Existing databases keep the names they were seeded with.
- `benchmarks/data/long-tasks.json` is now English. The numbers in the two reports were measured with the Chinese task text.
- Kept on purpose: the bge query instruction in `dsh/helmsman-embedding.js` (input for a Chinese embedding model) and the CJK ranges in the tokenizer/detector regexes. The knowledge base still handles Chinese content.
- `docs/文件去重CLI-设计说明.md` was renamed to `docs/file-dedupe-cli-design.md`.
- The browser speech-recognition locale (voice input is hidden) changed from `zh-CN` to `en-US`.
