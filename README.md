# 🐳 Helmsman

<p align="center">
  <img src="images/helmsman-wordmark.svg" width="360" alt="Helmsman" />
</p>

> **A task-based AI workspace for solo developers** —— projects are the unit of isolation, tasks are the unit of execution,
> comments are the control channel, and a per-project knowledge base is the persistent memory. You take the helm, the agent rows.

Helmsman is a local-first, self-hosted coding-agent workspace: it turns "chatting with an agent" into "managing tasks".
Each task is its own session; when it finishes, its conclusions are captured into the project knowledge base automatically, and the next task is assembled with the relevant knowledge automatically ——
**context isn't lost, and work isn't repeated**.

> **Direction (in progress):** the Helmsman engine is planned to be retired in favour of a FlowKit/Temporal control plane driving
> [DeepCode](https://github.com/HKUDS/DeepCode) as the execution plane (Input → Triage → Project → Task → Memory).
> Nothing of that is built yet beyond the S0 probes. Start with [`docs/specs/001-deepcode-flowkit-execution-plane.md`](docs/specs/001-deepcode-flowkit-execution-plane.md)
> (Spec C, v0.3) and [`docs/specs/001a-s0-findings.md`](docs/specs/001a-s0-findings.md). The sections below describe the current Helmsman code.

## Spec C status

| Phase | State | Where |
|---|---|---|
| S0: DeepCode viability (mock model) | Done, verdict GO | `docs/specs/001a-s0-findings.md`, `spikes/s0/` |
| S1: one `runSubagent` with a real model and key | **Not run. Run it in your own environment** | Spec C §10, S1 row |
| S2 to S6 | Not started | Spec C §10 |

### Running S1 elsewhere

S1 needs things this sandbox lacked: a real model API key (set it yourself, never commit it), a Temporal dev server, `git`, and ideally bubblewrap for the OS sandbox.
S0 already shows how to drive DeepCode: see `spikes/s0/README.md` (same RPC probes, with a real provider in place of the mock).
Exit criteria are in Spec C §10: zero duplicate threads or turns after killing the worker mid-turn, bounded cancellation, denied writes classed as failed, a failing Goal check not accepted, and a Goal paused by a service restart resumed by the retried activity.
DeepCode's service claims port 3081, the same port as Helmsman's engine, so do not run both.
FlowKit changes this depends on are on `teopeurt/flowkit`, branch `feat/auto-gated-ai-steps` (specs in its `docs/superpowers/specs/`).

## ✨ Highlights

- **Tasks are sessions**: creating a card runs it automatically, managed on a board; one card can have multiple executions (fork a new generation)
- **Comments are control**: no interrupting pop-ups; every instruction/decision goes through the comment stream + the approval queue (a first-class surface)
- **Waiting state machine**: plan awaiting approval / permission request / acceptance gate / cost budget —— when a task is stuck it says clearly "why, and what it needs"
- **Preset profiles**: the axes (collaboration mode × execution setting × approval posture × sandbox) collapse into named presets,
  and you pick one when creating a card; plan mode produces a plan for you to approve automatically, and the delivery setting enforces an acceptance gate
- **Project knowledge base**: tasks are captured automatically on completion (with a specificity bar, so generic summaries stay out), bitemporal + trust levels
- **Context assembly**: new tasks automatically carry earlier conclusions (prefix partitioning → KV-cache hits, lower cost)
- **Controlled experiments**: run the same task set twice, "with assembly vs bare", and use acceptance pass rate / cost data to answer "does assembly actually help"

## 🚀 Quick start

### Prerequisites

- Node.js ≥ 22
- `DEEPSEEK_API_KEY` (the engine calls DeepSeek)

### Start

Helmsman takes the **engine-plugin form** (the same shape as the official dsh web): all business logic runs as plugins inside the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) engine process,
and a single process serves the API + the live event stream. The frontend talks to the engine directly through the Vite proxy.

```bash
# 1. Engine (dsh/) —— a single process containing all Helmsman business plugins
cd dsh && pnpm install
node launcher.mjs cordis.yml                        # → http://127.0.0.1:3081

# 2. Frontend (web/)
cd web && pnpm install && pnpm dev                  # → http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 in a browser → register a project directory → create a card → board / approvals / knowledge base.
(The Vite proxy forwards `/api` and `/api/events` to 3081 —— the engine is the server; there is no separate product-service process.)

### Tests

```bash
# Engine plugin chain validation (each plugin ships its own cordis composition for validation, see dsh/*.cordis.yml)
```

## 🏗 Tech stack

| Layer | Technology |
|---|---|
| Engine | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh, engine-plugin form: HTTP gateway + orchestration + projection + approvals + knowledge base + worktrees all inside the engine process) |
| Engine plugins | JavaScript (ESM) · cordis composition · official dsh-host-webserver / dsh-agent-presets / dsh-user-approval |
| Frontend | React 18 · Vite · zustand |

## 📁 Layout

```
dsh/         dsh engine composition + Helmsman business plugins (helmsman-api/tasks/board/approval/kb/worktree/model-select)
  ├─ cordis.yml            main composition (engine process = all services)
  ├─ helmsman-*.js         business plugins (API / orchestration / projection / approvals / knowledge base / isolation / model switching)
  ├─ agent-presets/        task-level presets such as guard (tools/persona)
  └─ *.cordis.yml          standalone validation compositions for each plugin
web/         React frontend (talks to the engine on 3081 directly through the Vite proxy)
```
> The v1 standalone product service (server-ts) has been retired and deleted: its full history is kept on the `archive/v1-acp-client` branch + the `v1-acp-client` tag.

For a walkthrough of how the pieces fit together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 🗺 Roadmap

- [x] P0: asset cards / approval queue / session drill-in / knowledge-base assembly / three-axis presets / controlled experiments
- [x] P1 · requirement calibration flow (the AI proposes acceptance criteria; approval writes them back to the card)
- [x] P1 · goal mode (goal mode + checkpoint confirmation per phase)
- [x] P1 · Yolo (fully hands-off approval axis, checkpoints skipped)
- [x] P1 · policy learning · decision capture (remember checkbox → policy atom → suggestion at count≥2 → one-click adoption)
- [x] P1 · sequential task curves (metrics page by execution order + A/B grouping for controlled experiments)
- [x] P1 · distillation agent (distill preset + separate ACP session, zero pollution of the main conversation; rule-based fallback)
- [x] P1 · policy learning · command-level allowlist (exact matching of rm/sudo/git push → decided in the approval queue; idempotent rejection via policy capture; skipped on the yolo axis)
- [x] P2 · vector retrieval (local bge-small-zh embeddings, hybrid retrieval: rule + semantic channels; D3-8 restored the semantic channel)
- [x] P2 · knowledge evolution (dedupe before capture + automatic merging in the library + poisoning detection)
- [x] P2 · file content preview (read endpoint + syntax highlighting + Markdown rendering)
- [x] P2 · hot-reloaded settings (retrieval threshold / brief entry count, persisted in storage, no restart needed)
- [x] P2 · a real home page (source-control panel / recent captures / pending approvals / git status)
- [x] P2 · concurrency control (git worktree isolation + a limit on simultaneous tasks, fixing shared-workspace write conflicts at the root; this replaces the earlier "write-conflict detection" item)
- [x] P2 · theme/skin system (theme.json token overrides + theme.css full makeovers + backgrounds; import/export/persistence)
- [ ] P2 · desktop shell (Tauri v2 sidecar —— the distribution layer, scheduled after the core loop is stable + the command-level allowlist; trigger signal: "two terminal commands + a browser" gets annoying, or people unfamiliar with dsh need to use it)

**Architecture evolution (engine plugins)**:
- [x] Migration decision: standalone ACP client → engine-ecosystem plugin form (v1 archived on the `archive/v1-acp-client` branch + the `v1-acp-client` tag)
- [x] D3-1 gateway first: an HTTP server inside the engine process (the official dsh-host-webserver)
- [x] D3-2 orchestration moved in: tasks driven by agents.create/followup (zero ACP patches)
- [x] D3-3 observation moved in: live session/event stream (replaces JSONL tail polling)
- [x] D3-4 business logic as plugins: approvals (approval answerer) / knowledge base (in-engine distill) / worktree isolation
- [x] D3-5a engine-side cleanup: deleted 3 ACP patches, merged the business plugins into the main composition
- [x] B1 API surface completed: all 28 endpoints accepted (projects/cards/tasks/chats/approvals/kb/metrics/experiments/fs/presets)
- [x] B2 frontend switchover: Vite proxy → engine, WS/SSE live event stream, page rendering verified via CDP
- [x] server-ts retirement cleanup (the v1 standalone service was deleted; history kept on the archive/v1-acp-client branch + the v1-acp-client tag)

**Migration gaps filled (v1 capabilities that didn't come along during the plugin migration, inventoried 2026-08)**:
- [x] D3-6 acceptance gate moved in: `evidence.ts` (take a git snapshot for the approver when a task is Done) + `verify.ts` (run the card's acceptance command, decided by exit code) → added to the approval flow
- [x] D3-7 cost pricing moved in: `pricing.ts` peak/off-peak pricing → real metrics `cost` (previously hard-coded to 0, which made the metric curves meaningless)
- [x] D3-8 vector retrieval moved in: `embedding.ts` (bge-small-zh semantic channel) → hybrid retrieval restored (previously rule-based only)
- [x] D3-9 context assembly moved in: `assembly.ts` → at task start, hybrid-retrieval hits + a stable prefix block are assembled into the first prompt (with debt demotion; the brief snapshot goes into metrics and is shown in the frontend brief tab)

**Design reference (2026-09): [WikiSkill](https://arxiv.org/abs/2608.27454) (Google, arXiv:2608.27454)** —— compiling agent experience into a persistent knowledge layer so skills get stronger with use (three layers: raw trajectories / a wiki of patterns + anti-patterns + applicability / skills as executable handbooks). The lightweight tier has landed: knowledge entries gain `anti_patterns` + `applicability`, distill extracts them automatically, they are injected along with hits at assembly time, and the frontend detail view shows them. Key open item: the executor should run an "internalized skill" rather than querying the wiki directly (open wiki access at inference time actually hurts generalization) —— which corresponds to a future "knowledge → project-level executable skill" layer.

**In-house (2026-09): CWL structured context eviction (standalone plugin [`dsh-cwl`](https://github.com/kalifun/dsh-cwl), paradigm from [arXiv:2606.11213](https://arxiv.org/abs/2606.11213))** —— beyond summary compression: the trajectory is automatically derived into a typed episode graph (expl exploration / act actions + dependencies); an `agent/pre-step` waterfall checks the token budget before every LLM call, and above the threshold uses surface replace to **deterministically strip** the oldest completed act segments (zero LLM calls, no summary hallucination, causal structure preserved, user messages never evicted). This differs from the community's summary-based plugins (ACP); it ships `cwl_mark`/`cwl_recall` tools (active annotation + on-demand recall after eviction). The eviction mechanism is implemented and validated (two rounds of experiments: input -64%, steps -13%); the general capability is published as a standalone plugin and Helmsman consumes it as a dependency.

> Status baseline: verified against the code in 2026-08 (the README checkboxes are a snapshot; the repository is the source of truth for how interfaces/services evolve).

## 📄 License

MIT (the dsh engine is MIT, see [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness))
