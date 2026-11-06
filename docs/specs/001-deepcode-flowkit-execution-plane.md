# Spec C: DeepCode as the execution plane for FlowKit (Option B)

**Status:** DRAFT v0.2, awaiting approval. Nothing here is built. v0.2 adds the Input, Triage, Project, Task and Memory domain model (§2a, §9a, §9b); sections 1 to 13 otherwise keep their v0.1 meaning and the spike phases S0 to S4 are unchanged.
**Depends on:** Spec A (`gate: auto`) and Spec B (`orchestrate`), both implemented on the local, **unpushed** FlowKit branch `feat/auto-gated-ai-steps` (`51dcb7c`, `bbe959b`). FlowKit 1.1.0 is not published, so this work links to a local checkout until it is.
**Replaces:** Helmsman's engine (`dsh/` plugins). Helmsman is retired, not fixed. Nothing has been deleted yet: that happens on this branch only after S0 gives a go.
**Lives in:** `teopeurt/deepkode`, on branch `claude/deepcode-flowkit-execution-plane` (decision D6, made by the project owner). Specs A and B live with FlowKit, not here.
**Nature of this document:** a design plus a time-boxed spike plan. It has more unknowns than Specs A and B; §3 lists which statements are verified and which are not.

---

## 1. Goal

Run an autonomous, production-grade engineering workflow in which:

- **FlowKit on Temporal** decides *what happens, in what order, who approves, when it times out, and what the audit trail says*.
- **DeepCode** does the *agent work*: reading and editing code, running tests, verifying, in sandboxed, isolated workspaces.
- Inputs (call notes, customer email, Slack, crash reports) enter as FlowKit signals or workflow starts.
- Every workflow plans, then gets an adversarial critique of the plan, *then* executes. Models are chosen per role, not globally.

**Non-goals for this spec:** a custom UI, the input connectors themselves (contract only, §9), multi-tenant operation, and any change to FlowKit beyond Specs A and B. The knowledge base is **in scope** from v0.2, as the Memory service (§9b).

## 2. Architecture

```
 inputs (Slack / email / notes / crash)          Temporal server
        │  normalize, dedupe, signal                  │
        ▼                                             ▼
 ┌──────────────┐   start / signal   ┌─────────────────────────────┐
 │ intake       │ ─────────────────▶ │ FlowKit workflow (control)  │
 │ adapters     │                    │  stages, gates, SLA, audit  │
 └──────────────┘                    └──────────────┬──────────────┘
                                                    │ activities
                                     ┌──────────────▼──────────────┐
                                     │ worker (TypeScript)         │
                                     │  plan / runSubagent /       │
                                     │  synthesize / recordTransition
                                     └──────────────┬──────────────┘
                              JSON-RPC (target) or `deepcode exec` (spike)
                                     ┌──────────────▼──────────────┐
                                     │ DeepCode service (Python)   │
                                     │  sessions, goals, sandbox,  │
                                     │  approvals, providers, MCP  │
                                     └──────────────┬──────────────┘
                                                    ▼
                                       git worktree per subagent task
```

| Concern | Owner |
|---|---|
| Stage graph, ordering, gates, human approval, SLA timers, escalation, audit | FlowKit / Temporal |
| Retries, timeouts, durability across restarts, cancellation | Temporal |
| Agent loop, tools, sandbox, per-tool approvals, model calls | DeepCode |
| Verified completion of one unit of work (checklist, reviewer) | DeepCode Goals |
| Which model each role uses | Worker configuration (not the definition) |
| Worktree creation, merge, conflict handling for FlowKit subagents | Worker |

**Nesting rule.** `orchestrate` is the only fan-out across subagents in a flow. DeepCode's own `spawn_agent` is not used for that. It may still be used *inside* a single activity for small helpers, because it is model-driven and not durable and would otherwise nest two orchestrators.

## 2a. Domain model: Input, Triage, Project, Task, Memory

The product keeps Helmsman's central idea (projects, tasks, memory) and runs it on the architecture above.

```
Input ──▶ Triage ──▶ Project ──▶ Task ──▶ Memory
 raw       shared     long-lived  FlowKit   captured on approval,
 events    FlowKit    context     workflow  read at triage and plan
           flow
```

| Concept | Definition | Realised as |
|---|---|---|
| **Input** | A raw event from a channel: Slack message, email, call note, crash report. | A normalized record (§9), stored by reference, deduplicated by a stable id. |
| **Triage** | Turns an input into a decision: discard, answer, merge into an existing task, ask a human, or create a task in a project. | **One shared FlowKit flow** for every input type (§9a). Source-specific differences are data and pre-processing, not separate flows. |
| **Project** | The long-lived unit of context and policy. **It may span several repositories.** | A registry record, not a workflow: repos, per-repo check commands, conventions, autonomy and budget policy, allowed channels, model overrides, SLAs, memory namespace. |
| **Task** | One unit of work in one project. | One FlowKit workflow (the plan, critique, execute, security, review flow of §8). `subject.id` is the task id and `subject.organizationId` is the project id. |
| **Memory** | What the project has learned, kept across tasks. | A Memory service with Helmsman's trust model (§9b). |

### Projects that span several repositories

A project lists its repositories, each with a remote, a default branch, and its own check commands. Rules that follow:

- **Tasks are planned per repository.** Each orchestration task carries a `repo` field in its `input`, and worktrees, integration branches and checks are per repository. DeepCode's thread takes a single `workspacePath`, so one subagent works in one repository unless U9 shows multi-root workspaces are supported.
- **Cross-repository coordination happens at plan and synthesis level.** The planner emits tasks across repos with declared ordering; the synthesizer reports per-repo results; the `review` stage sees all of them together.
- **There is no atomic cross-repo merge.** Nothing merges until every repository's integration branch has passed its checks and the `review` stage has approved. Merges then go in the planned order as pull requests. If a later merge fails after an earlier one landed, the flow stops at a human gate with the partial state described. It does not try to roll back. This is the hardest unsolved part of multi-repo support and is listed as risk R5.
- **A task's repository set is decided at triage** and recorded in task metadata. Widening it later goes back through a human gate.

## 3. What is verified, and what is not

**Verified by reading the DeepCode source and docs (it was not run):**

1. `deepcode exec --json` emits one JSON event per line with `msg.type`, including `turn_started`, `tool_started`, `tool_completed`, `agent_message`, `error`, and `task_complete` (with `stop_reason`).
2. `exec` exits 0 only if the turn completed, 1 otherwise, and 130 on interrupt. `--detach` returns `{threadId, turnId, status, detached}` and exits 0.
3. **`exec` has no idempotency key.** Retrying it starts a second session and turn.
4. SIGINT makes `exec` call `turn/interrupt`. Cancelling only the client waiter does not stop an already-admitted turn, so killing the process leaves the turn running in the service.
5. In non-interactive Ask mode an approval that cannot be answered is denied. `--access` takes `read-only`, `ask`, or `full-access`; `--access full-access` removes approvals and the sandbox.
6. The JSON-RPC protocol has `thread/start` (`projectId`, `workspacePath`, `agentPreset`, `parentThreadId`, `connectionId`, `model`, `reasoningEffort`), `turn/start` (requires a caller-supplied **`messageId`**), `turn/interrupt`, `turn/read`, an event-replay method, and approval-respond. The service listens on `127.0.0.1` and clients authenticate with a token file.
7. Goals can carry confirmed check commands (`--check`, `--test-cmd`), a token or time budget, and an optional independent read-only reviewer. A Goal active at restart is **paused**, not continued, and `deepcode loop --resume SESSION_ID` continues it.
8. Native subagents are model-driven, at most 5 concurrent, depth 1, isolated in worktrees by default, merged back with git's 3-way merge reporting conflicts. External `codex` and `claude-code` CLIs are available as subagent backends.
9. A new workspace needs project trust (`--trust`, once per project).

**Not verified (each is a spike question, §10):**

- U1. That `turn/start`'s `messageId` is a true idempotency key (a repeated id returns the same turn rather than a second one).
- U2. How an out-of-process client connects: the service's HTTP/WebSocket surface with the token file, or a stdio app-server per client. The P1 architecture doc describes stdio only; the service evidently has a network surface.
- U3. Whether trust is per path, so every new git worktree needs a trust step, and how to do that non-interactively and safely.
- U4. Whether a top-level turn can return schema-validated structured output. A forced `submit_result` capture tool exists for sub-agents; its exposure to `exec`/`turn/start` is unknown.
- U5. Whether `claude-fable-5-1` and the other target models work through DeepCode's Anthropic provider, and whether native subagents can use a model other than their parent's (the code suggests they inherit it).
- U6. The real behaviour of an unattended `ask`-mode turn that needs writes, and whether pre-approved rules can express "allow edits inside this worktree, deny network".
- U7. Token and cost reporting per turn, for budgets and metrics.
- U8. Behaviour when the DeepCode service restarts mid-turn (what state does the turn end in, and can the activity re-attach).
- U9. Whether a DeepCode thread can use a multi-root workspace, or only one `workspacePath`. Assumed one until shown otherwise (§2a).
- U10. Which embedding model gives acceptable retrieval on English and mixed content. Helmsman used `bge-small-zh-v1.5`, a Chinese model, so it is not carried over.

## 4. The activity contract

### 4.1 Transport

Target: the JSON-RPC surface (idempotent `messageId`, `turn/interrupt`, `turn/read`, event replay). Spike: shell out to `deepcode exec --json --detach`/`loop`, then poll, because it is available today. The worker hides the transport behind one interface so the switch does not touch FlowKit.

```ts
interface ExecutionPlane {
  start(req: { key: string; role: Role; workspace: string; access: Access;
               prompt: string; connection: string; model: string;
               checks?: string[]; tokenBudget?: number }): Promise<{ threadId: string; turnId: string }>;
  watch(ref: Ref, onEvent: (e: AgentEvent) => void): Promise<TurnResult>; // heartbeats from events
  interrupt(ref: Ref): Promise<void>;                                     // confirmed, not fire-and-forget
  read(ref: Ref): Promise<TurnResult>;
}
```

### 4.2 Idempotency (a requirement, because `exec` has none)

The worker keeps a small store of `idempotencyKey -> { threadId, turnId }`, where the key is FlowKit's `[workflowId, entryEpoch, stepIndex, phase, taskId]`. On any activity attempt: look the key up first. If found, **re-attach** (`read`/`watch`) instead of starting. Only start when absent, and write the mapping *before* the first model call returns work. Result: an activity retried after a worker crash never creates a duplicate session. Execution activities use a small `maximumAttempts` (2 to 3) with a non-retryable error type for "turn finished and failed".

### 4.3 Cancellation

A Temporal activity cancel (stage change, SLA escalation, human takeover) must stop the agent. The activity heartbeats on every event and, on cancellation, calls `interrupt` and waits for confirmation, then reports the task `cancelled`. If confirmation cannot be obtained, the worker marks the thread for cleanup and records an alert. It never assumes a killed client stopped the turn (verified fact 4).

### 4.4 The three orchestration activities

| FlowKit activity | DeepCode call | Access | Output |
|---|---|---|---|
| `planOrchestration` | One turn, planner role, read-only | `read-only` | Validated JSON `{ tasks: [{ id, agent, input }] }`. Invalid or unparsable JSON gets one corrective retry, then the activity fails (so the step degrades to a human). |
| `runSubagent` | A Goal (`loop`) for `coder`/`tester`; a turn for read-only roles. Runs in the task's worktree. | per role, §6 | `{ output: summary, outputRef: <patch or report path> }`. Large artifacts stay on disk; workflow state keeps only the reference. |
| `synthesizeOrchestration` | One read-only turn, or a deterministic function when no judgement is needed | `read-only` | Merged output within `maxOutputBytes`. |

Subagents that *change code* use `loop` with confirmed `--check` commands, so DeepCode itself refuses to call a task complete until the checks pass. A restart pauses the Goal, and the retried activity resumes it with `--resume`. This combines Temporal's durability with DeepCode's verified completion.

## 5. Workspaces and merging

- One `git worktree` per subagent task, created by the worker off a recorded base commit, named from `{workflowId}/{epoch}/{repo}/{taskId}` (no short random suffixes; `repo` because a project may span several).
- Each task is trusted before use (U3). Trusting is a deliberate worker step, never an `--trust` on user-supplied paths.
- On a successful task the worker commits in the worktree and merges to a per-workflow integration branch with a 3-way merge; **a conflict marks the task `failed` with reason `conflict`**, aborts the merge so nothing is left half-merged, and the plan/`decide` rule sees it. Nothing merges into the default branch without passing the `review` stage.
- Cleanup (remove worktree, delete thread) runs from a separate cleanup path that survives cancellation.

## 6. Autonomy and security policy

Inputs from email and Slack are **untrusted text**. An agent that can edit files and run commands and that reads them can be steered by them. The design is defence in depth, not trust in the model:

| Stage / role | Access | May auto-release? | Notes |
|---|---|---|---|
| `plan` (planner) | read-only | Yes, via rule on schema validity and task count | Receives intake text as quoted data. |
| `critique` (adversary) | read-only | Yes, only if the rule finds no blocking findings | The critique is a different role and ideally a different model from the planner. |
| `execute` (coder, tester) | write inside its worktree only | Yes for low-risk classes; **human gate for any run whose source is an untrusted channel** until proven | Network off. No credentials in the environment. |
| `security` (pen-test) | read-only plus a throwaway environment | **No**, always human | |
| `review` | human | n/a | |

Open decision D3 is how unattended writes are permitted (U6): a pre-approved rule set, or `full-access` inside a disposable container or VM per task. I recommend the latter if U6 shows the rule set cannot express worktree-scoped writes.

Further controls: token budgets on every Goal; Temporal timeouts and the stage SLA bound the wall clock; a per-workflow cost ceiling checked by a guard; an allowlist of intake channels and authors; no outbound network from execute/security tasks except through an allowlisted gateway.

## 7. Model routing

A worker configuration table maps **role to connection and model**, outside the definition, so a model change is a deploy of configuration, not a new flow version:

```yaml
roles:
  planner:   { connection: anthropic, model: <opus>,   effort: high }
  adversary: { connection: anthropic, model: <opus>,   effort: high }   # independent of planner
  coder:     { connection: anthropic, model: <opus>,   effort: medium }
  tester:    { connection: anthropic, model: <sonnet>, effort: low }
  copy:      { connection: anthropic, model: <sonnet>, effort: low }
  security:  { connection: anthropic, model: <fable>,  effort: high }   # U5: unverified
```

Model ids are placeholders until U5 is confirmed. Dynamic selection (for example escalating the model after a failed Goal) is a worker rule using the task's retry count, not something FlowKit knows about.

## 8. The first flow

The plan, critique, execute, security, review pipeline from Spec B §12, with: `plan` and `critique` as `orchestrate` steps with auto gates, an iteration bound (a `revise` loop limited to N passes, enforced by a guard on a counter in subject metadata), `execute` as `orchestrate` with `allTasksClean`, `security` human-gated, and `review` human. Every stage has an SLA.

## 9. Intake contract (adapters out of scope)

An adapter normalizes an event to `{ source, externalId, author, receivedAt, body, attachments }`, derives `workflowId = intake:<source>:<externalId>`, and starts the flow (Temporal's workflow-id reuse policy dedupes repeats) or signals a running one. Slack (rooms, crash reports) and email can be connected through MCP servers or small webhooks. Granola's API availability is unchecked. Raw bodies are stored by reference; the workflow carries identifiers and a bounded summary.

## 9a. Triage: one shared flow

All inputs, whatever their source, enter the same FlowKit flow. The source and a trust label (`untrusted` for email, public Slack and customer reports; `internal` for notes and trusted rooms) travel as task metadata and drive policy, not the flow's shape.

Shape (illustrative, not final YAML):

```yaml
id: triage
stages:
  received:   # normalize, attach provenance, store the body by reference
  classify:   # ai step, read-only, cheaper model: kind (bug | feature | question | feedback | crash | noise),
              # confidence. gate: auto, decide: classificationConfident
  dedupe:     # system step: search open tasks and Memory for the same issue. rule decides: new | merge | known-answer
  route:      # ai step: project, repositories, priority, risk class, autonomy level. gate: auto, decide: routingConfident
  needs_human:  # human gate: confirm / edit routing / discard. Reached whenever a rule declines
  create_task:  # system step: start the Task workflow; rule then moves to the final stage
  merged: { final: true }      # attached to an existing task by signal
  discarded: { final: true }
  answered: { final: true }    # known answer from Memory, no task
  done: { final: true }        # task created
```

Properties:

- **The only output is structured data.** Raw input text is never an instruction to a writing agent: it is quoted as data in the plan prompt and is not given to `execute` roles directly.
- **Fails closed.** Low confidence, a declined rule, or an error lands in `needs_human` (Spec A's behaviour).
- **Untrusted sources require a human gate before `execute`** (D4), set by the `create_task` step in the task's metadata and enforced by a guard in the task flow.
- **Duplicates collapse twice**: by workflow id at intake (§9) and semantically at `dedupe`.
- **Per-source preprocessing** (for example parsing a crash report or summarizing a call note) runs in the intake adapter, before the flow, and produces the same normalized record.

## 9b. Memory service

Memory is a service with a defined interface, taken from Helmsman's knowledge base design (not its code, which had unwired parts: metrics were never saved, and two features were no-ops).

**Note model:** `id`, `projectId`, optional `repoScope`, `title`, `content[]`, `tags`, `keywords`, `summary`, `antiPatterns[]`, `applicability`, `links`, `source { kind, ref }`, `validFrom`, `validUntil`, `invalidatedBy`, `version`, `trust`, `origin`, timestamps.

- `trust`: `human-approved`, `agent-generated`, `unverified`.
- `origin`: `trusted` or `untrusted`, recording the channel the knowledge came from. This is new, and exists to stop poisoning.

**Interface:**

| Operation | Behaviour |
|---|---|
| `capture(taskId)` | Run by a system step **after the `review` stage approves**, never earlier. Distills the finished task into notes. A task that began from an untrusted input yields notes with `origin: untrusted`. |
| `retrieve(projectId, query, { repoScope, limit })` | Hybrid retrieval: keyword rules plus semantic similarity, filtered by validity window. |
| `assemble(projectId, taskText)` | Returns the stable prefix, the relevant hits, and a snapshot id. The snapshot id is recorded on the task for audit. |
| `invalidate`, `pin`, `unpin`, `list` | Maintenance. Only humans may mark a note `human-approved` or pin it into the stable prefix. |

**Rules:**

1. **Poisoning guard.** Notes with `origin: untrusted` or `trust` below `human-approved` never enter the stable prefix and never feed an auto-gate decision until a human approves them.
2. **Readers:** triage (`dedupe`, known answers), plan, critique, and the assembled prompt for execute. The first version injects memory by prompt assembly only. An on-demand memory tool for agents is deferred because it opens a second read path for injected content.
3. **Writers:** only the `capture` step and human maintenance.
4. **Validity is bitemporal:** an outdated note is invalidated, not deleted, so past tasks remain explainable from their snapshot.
5. **Storage:** SQLite to start, behind the interface, so it can move to Postgres. The first implementation runs in the worker process behind the service interface and can be split out later (D7).

## 10. Spike plan (time-boxed)

| Phase | Work | Exit criteria |
|---|---|---|
| S0 | Install Temporal dev server and DeepCode; link FlowKit locally; run `exec --json` on a toy repo; answer U1 to U8 | Written answers for U1 to U8 and a go/no-go on the transport |
| S1 | One `runSubagent`: worktree, trusted, `loop` with checks, idempotent re-attach, cancel via interrupt | Kill the worker mid-turn and restart: **zero duplicate sessions**; cancel stops the agent within a bounded time |
| S2 | `orchestrate` with plan (validated JSON), 2 to 3 subagents, synthesize, auto gate; failure injection (bad plan, failed task, conflict) | Every injected failure ends in a human gate, never a silent release |
| S3 | Full pipeline with critique and security stages, human approval, SLA escalation | A run completes end to end; an SLA timeout escalates and cancels cleanly |
| S4 | One real intake channel into the flow; dedupe; a prompt-injection test set | Duplicates collapse; injected instructions do not alter files outside the plan |
| S5 | The shared triage flow (§9a) over two different input types, with a two-repository project; `needs_human` on low confidence | Both input types classify and route correctly on a labelled sample; a wrong or low-confidence case always reaches a human; a two-repo task produces per-repo worktrees and checks |
| S6 | Memory (§9b): capture after review, retrieval at triage and plan, snapshot id on the task; a memory-poisoning test set | A repeated issue is recognised from memory; untrusted-origin notes never reach the stable prefix or an auto-gate; the embedding choice (U10) is made on measured retrieval quality |

**Metrics recorded from S1:** success rate, human interventions per workflow, cost and tokens per workflow, wall-clock per stage, duplicates (must be 0), resume correctness after restarts of the worker, the DeepCode service, and Temporal.

**Stop conditions:** if U1 and U3 both fail, or S1 cannot reach zero duplicates, stop and reconsider before building more.

## 11. Retiring Helmsman

Retired: `dsh/` plugins, the SQLite schema, the board projection. Kept as **design**, rebuilt in this project: projects, tasks and the knowledge base (§2a, §9b). Lost unless rebuilt: the kanban/approvals UI. For the spike, use the Temporal UI for workflow state and DeepCode's Web client for session detail. A purpose-built status page, and whether to keep Helmsman's web front end on top of FlowKit state, is decision D5 and is deferred. Port 3081 is used by both the old Helmsman engine and the DeepCode service; the engine is not run alongside.

## 12. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve Option B and this spike as the next step | Yes, S0 first with go/no-go |
| D2 | Worker language | TypeScript (FlowKit's native language) |
| D3 | How unattended writes are permitted | Disposable container per task unless U6 shows scoped rules suffice |
| D4 | Should untrusted-channel runs always require a human before `execute` | Yes initially |
| D5 | UI: Temporal UI plus DeepCode Web now, custom later | Yes |
| D7 | Memory: a service interface with an in-process first implementation (recommended), or a separate process from the start | In-process behind the interface; split later |
| D8 | Multi-repo merge policy (§2a): all-or-nothing is not possible; stop at a human gate on partial failure | Approve as written |
| D6 | Where this spec and the worker live | **Decided:** `teopeurt/deepkode`, branch `claude/deepcode-flowkit-execution-plane`. FlowKit stays generic. |

## 13. Risks

- Prompt injection via intake text is the largest risk and is mitigated by layers, not eliminated.
- Two fast-moving dependencies (DeepCode releases every few days; FlowKit 1.1.0 unpublished) that must be pinned.
- Cost: planner plus adversary plus subagents multiplies model calls per workflow; budgets and metrics from S1 are required before any production use.
- DeepCode is a large product; only its headless and RPC surface is used, so most of it is unused weight.
- R5. Multi-repo merges are not atomic; a partial failure needs human recovery (§2a, D8).
- R6. Memory poisoning: untrusted input could try to plant notes that later steer agents. Mitigated by `origin`, the trust rules in §9b, and the S6 test set, not eliminated.
- R7. Triage mistakes (wrong project, a missed duplicate) waste work. Confidence rules and `needs_human` bound them; S5 measures the error rate.

## 14. Decisions recorded at v0.2

| Question | Decision |
|---|---|
| Memory: service with Helmsman's trust model, or DeepCode's files only? | A service with Helmsman's trust model (§9b). |
| Does a Project span one repository or several? | Several (§2a). |
| One triage flow or one per input type? | One shared flow (§9a). |
